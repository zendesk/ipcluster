var
	fs               = require('fs'),
	os               = require('os'),
	net              = require('net'),
	events           = require('events'),
	util             = require('util'),
	Worker           = require('./workerwrapper.js'),
	spawn            = require('child_process').spawn,
	exec             = require('child_process').exec,
	clog             = require('./clogger')('[Master.' + process.pid + ']'),
	Q                = require("q"),
	HashWithLength   = require('./HashWithLength'),
	CommandProcessor = require('./CommandProcessor'),
	putil            = require('./process_util'),
	IPTSet           = require('./iptables');

module.exports = Master;

var default_options = {
	current_ip:          '127.0.0.1',
	hostname:            'localhost',
	num_workers:         os.cpus().length,
	ports:               [80],
	connect_timeout:     3 * 1000, // 3s
	ping_timeout:        5 * 1000, // 5s
	monitor_interval:    1 * 1000, // 5s
	totalmaxheap:        512 * 1024 * 1024, // 512 MB
	spawn_delay:         1511, // large prime number to reduce overlapping cumulation delay
	soft_kill_timeout:   5 * 1000, // 5s
	retire_rss:          448 * 1024 * 1024, // 448 MB
	debug:               false,

	retire_rate:         10, // 10
	retire_window:       2 * 60 * 1000 // 2 minutes
};

function noop(){}

function isPowerOfTwo(n) {
	return (n !== 0) && ((n & (n - 1)) === 0);
}

function Master(options) {
	this.options = util._extend(util._extend({}, default_options), options);
	this.options.num_workers  = +this.options.num_workers;
	this.options.totalmaxheap = +this.options.totalmaxheap;
	this.options.retire_rss   = +this.options.retire_rss;

	if (!this.options.retire_rss || !this.options.totalmaxheap) {
		throw new Error("Heap thresholds not provided");
	}

	this.options.worker_retire_rss           = this.options.retire_rss;
	this.options.cluster_heap_low_watermark  = this.options.totalmaxheap * 0.8;
	this.options.cluster_heap_high_watermark = this.options.totalmaxheap * 0.95;

	this.set_kill_strategy(Master.kill_strategies.conn_rss_time);

	// at this point in the implementation of ipcluster, we require num_workers to be a power of 2
	if (!isPowerOfTwo(this.options.num_workers)) {
		throw new Error("IpCluster only works with power-of-2 workers");
	}
	this.workers       = new HashWithLength();
	this.old_workers   = [];
	this.worker_bands  = new Array( this.options.num_workers );
	this.retire_events = [];
	this.worker_monitor_IID = null;
	this.iptSet = new IPTSet(
		this.options.current_ip,
		this.options.num_workers,
		this.options.ports
	);

	this.check_bands = this.check_bands.bind(this);
	this.handleWorkerPingTimeout = handleWorkerPingTimeout.bind(this);

	// Note: we find the old workers, but we do not set their connect timeouts until AFTER the IPC server is up
	this.all_band_furnished_deferred = Q.defer();
	this.kill_previous_master()
		.then( this.find_old_workers         .bind(this) )
		.then( this.setup_ipc_server         .bind(this) )
		.then( this.refill_workers           .bind(this) )
		.then( this.retire_old_workers       .bind(this) )
		.then( this.set_signal_handlers      .bind(this) )
		.then( this.monitor_worker_pool      .bind(this) )
		.fail( clog )
		.done();
}

util.inherits(Master, events.EventEmitter);

Master.kill_strategies = {
	time: function(a, b) {
		// sort bigger uptime first
		var sa = a.getStats(), sb = b.getStats();
		return sb.uptime - sa.uptime;
	},
	conn_rss_time: function(a, b) {
		// sort by lower sockets, then bigger rss, then bigger uptime
		var sa = a.getStats(), sb = b.getStats();
		if (sa.sockets != sb.sockets) return sa.sockets - sb.sockets;
		if (sa.mem.rss != sb.mem.rss) return sb.mem.rss - sa.mem.rss;
		return sb.uptime - sa.uptime;
	},
	rss_conn_time: function(a, b) {
		// sort by bigger rss, then lower sockets, then bigger uptime
		var sa = a.getStats(), sb = b.getStats();
		if (sa.mem.rss != sb.mem.rss) return sb.mem.rss - sa.mem.rss;
		if (sa.sockets != sb.sockets) return sa.sockets - sb.sockets;
		return sb.uptime - sa.uptime;
	}
};

var p = Master.prototype;

p.set_kill_strategy = function(sort_strategy) {
	// the kill strategy should prioritize workers which are in timeout state
	// and then prioritize workers which have already been told to die
	// so we don't risk hard-killing a worker before it went through the low_watermark notification
	this.kill_strategy = function(worker_a, worker_b) {
		if (worker_a.timeout === worker_b.timeout) {
			if (worker_a.dying === worker_b.dying) {
				return sort_strategy(worker_a, worker_b);
			}
			return worker_a.dying ? -1 : 1;
		}
		return worker_a.timeout ? -1 : 1;
	};
};

p.kill_previous_master = function() {
	clog('killing previous master');
	return this.get_previous_master_pid()
		.then( putil.kill, clog )
		.fail( clog );
};

var NETSTAT_RE = /^(unix)\s+(\d+)\s+\[\s+([^\]]+)\s+\]\s+([A-Z]+)\s+(LISTENING)\s+(\d+)\s+(\S+)\s+(.+)$/;
var PID_PNAME_RE = /^(\d+)\/(.+)$/;

function parseNetstat(stdout) {
	var lines = stdout.split(/[\r\n]+/);
	var res = [];
	for (var idx=0; idx<lines.length; idx++) {
		var m = lines[idx].match(NETSTAT_RE);
		if (!m) continue;
		var fields = {
			Proto:       m[1],
			RefCnt:      parseInt(m[2], 10),
			Flags:       m[3].split(/\s+/),
			Type:        m[4],
			State:       m[5],
			Inode:       parseInt(m[6], 10),
			Path:        m[8]
		};
		m = m[7].match(PID_PNAME_RE);
		if (m) {
			fields.PID = parseInt(m[1], 10);
			fields.ProgramName = m[2];
		}
		else {
			fields.PID = -1;
			fields.ProgramName = '-';
		}
		res.push(fields);
	}
	return res;
}

// Look in /proc/&/cmdline
// for --master --hostname
p.get_previous_master_pid = function() {
	var _self = this;
	// netstat command to list all processes listening on a unix domain socket
	var cmd = 'netstat -xlnp';

	return Q.nfcall(exec, cmd, { timeout: 1000 })
		.spread( parseNetstat )
		.then( function(items) {
			for (var idx in items) {
				var item = items[idx];
				if (item.Path === _self.options.uds) {
					clog("Found matching UDS", item);
					if (item.PID < 0) {
						clog("ERROR: Old master belongs to another user!");
						process.exit(1);
					}
					else {
						clog("Found old master at PID " + item.PID);
						return item.PID;
					}
				}
			}
			clog("No old master found");
			return -1;
		});
};

p.setup_ipc_server = function() {
	var deferred = Q.defer();

	this.server = net.createServer( this.handshake_setup.bind(this) );
	clog(this.options);

	var uds = this.options.uds;

	if (fs.existsSync(uds)) {
		clog("unlinking %s", uds);
		fs.unlinkSync(uds);
	}

	this.server.listen(uds, function() {
		clog('listening at ' + uds);
		deferred.resolve();
	});

	return deferred.promise;
};

p.handshake_setup = function(conn) {
	var
		conn_mgr = new CommandProcessor(conn),
		_self = this;

	function terminate() {
		conn_mgr.destroy();
	}

	function valid_handshake_handler(msg) {
		// initial handshake packet MUST contain at least:
		// * pid
		// * portmap
		// * mem
		// TODO: can we do more validation here? The portmap should have known keys (e.g. 80, 443)
		if (!(msg.pid && msg.portmap && msg.mem && ('band' in msg))) {
			conn_mgr.reply({error: "invalid message: pid missing"}, msg, 'error');
			terminate();
			clog("wrong data in handshake handler", msg);
			return;
		}

		clog('received ping from %d with portmap %s', msg.pid, JSON.stringify(msg.portmap));

		// hanshake sequence is OK, disconnect the now-useless catch-all handler
		conn_mgr.removeListener('__message', invalid_handshake_handler);

		// incoming payload is ok, send ok reply to finalize handshake
		conn_mgr.reply({}, msg);

		// assign the connection to the worker
		var worker = _self.workers.get(msg.pid);

		if (!worker) {
			// TODO: should there be special handling for this?
			// by right old workers were detected and are expected.

			// for now make a worker on the spot with the information we have
			// TODO: the pid here is being passed as a socket message, we should not blindly trust it,
			// but instead do a system level inspection of the actual process
			worker = _self.make_worker(msg.pid);
			worker.xband = msg.band;
			_self.old_workers.unshift(worker); // unknown workers are placed at the beginning of the pool
		}

		worker.setStats( msg );
		worker.setProcessor( conn_mgr );

		// on first ping for this worker, we set the iptable rule
		if (('band' in worker) && !worker.ipt_initialized) {
			worker.ipt_initialized = true;
			// this is an active worker, we need to remove unused rules for this band
			// and replace them with the ports reported
			_self.iptSet.add(worker.band, msg.portmap);
		}
		else if (!('xband' in worker)) {
			// when a worker controlled by a previous master shows up, we might not know yet what band it was from
			// we record it now based on the band information passed in
			worker.xband = msg.band;
		}
	}

	function invalid_handshake_handler(msg) {
		// disconnect the info listener from the handshake process
		conn_mgr.removeListener('info', valid_handshake_handler);
		clog('Invalid handshake received: ' + JSON.stringify(msg));
		terminate();
	}

	// handshake consists of an unrequested info packet
	// we set up 2 listeners:
	// - one or "info" (valid handshake),
	// - one for everything else (invalid handshake)
	conn_mgr.once('info',        valid_handshake_handler);
	conn_mgr.once('__message', invalid_handshake_handler);

	return conn_mgr;
};

// Look in /proc/&/cmdline
// for --hostname * --worker
p.find_old_workers = function() {
	var _self = this;

	return putil.ps()

		.then(function(processes) {
			var tmp_worker_pids = [];

			for (var pid in processes) {
				var cmdline = processes[pid];

				if (isWorkerCmd(cmdline)) {
					tmp_worker_pids.push(pid);
				}
			}
			return tmp_worker_pids;
		})

		.then(function(pids) {
			// retrieve and set worker bands for all workers, even before they connect to master
			return Q.allSettled(
				pids.map(function(pid) {
					return putil.getEnv(pid)
						.fail(noop)
						.then(function(env) {
							if (!env) return;
							if (env.__ZWORKER__ != 'TRUE') return;

							var worker = _self.make_worker(pid);

							if ('__ZWORKER__BAND__' in env) {
								worker.xband = parseInt(env.__ZWORKER__BAND__, 10);
							}

							_self.old_workers.push(worker);
						});
				})
			);
		})

		.then(function() {
			clog('Found %d old workers', _self.old_workers.length);
		});
};

p.retire_old_workers = function() {
	for (var idx = this.old_workers.length; idx--; ) {
		var worker = this.old_workers[idx];

		worker.startConnectTimeout(); // if one of the old worker doesn't connect, it'll be destroyed
		this.retire_worker(worker.pid, {reason: 'old worker'}); // if it connected or will connect, we'll instruct it to retire

		// Note: the settings below is in a environment variable, so as to not pollute the CLI args of the host app
		if (process.env.IPC_START_KILLOLD === 'TRUE') {
			worker.die(); // should we SIGTERM/SIGKILL instead?
		}
	}
};

p.clear_all = function() {
	// we need to revive the all-band-filled flow
	delete this.check_bands; // delete local copy
	this.check_bands = this.check_bands.bind(this); // rebind prototype method to instance
	this.all_band_furnished_deferred = Q.defer();

	var
		reason = "full restart",
		live_workers_copy = this.worker_bands.concat();

	// Instruct all live workers to retire
	for (var idx = live_workers_copy.length; idx--; ) {
		var worker = live_workers_copy[idx];

		if (!worker) continue;
		this.retire_worker(worker.pid, reason);
	}

	this.all_band_furnished_deferred.promise
		.then(this.clear_all_retired_workers.bind(this, reason))
		.done();
};

p.clear_all_retired_workers = function(reason) {
	var
		deferred = Q.defer(),
		_self    = this,
		reason   = reason || "Retiree cleansing",
		// we track the list or retired workers AT THIS POINT. These are the only ones we want to kill.
		old_retired_workers = _self.old_workers.concat();

	// we kill the retired workers with delay, to dampen the migrating hurd effect
	function destroy_next() {
		if (old_retired_workers.length <= 0) {
			return deferred.resolve();
		}
		destroyWorker.call(_self, old_retired_workers.shift().pid, reason, 0);
		setTimeout(destroy_next, _self.options.spawn_delay);
	}

	destroy_next();

	return deferred.promise;
};

p.set_signal_handlers = function() {
	process.on('SIGUSR1', this.clear_all_retired_workers.bind(this));
};

p.rate_limited_retire_worker = function(pid, reason_data) {
	var
		time_threshold = (+new Date()) - this.options.retire_window,
		idx = 0,
		len = this.retire_events.length;

	// remove expired events (events older than the time window)
	while(idx < len && this.retire_events[idx] < time_threshold) {
		idx++;
	}
	this.retire_events.splice(0, idx);

	// do not allow retirement if rate is above limit
	if (this.retire_events.length >= this.options.retire_rate) {
		return false;
	}

	this.retire_worker(pid, reason_data);

	return true;
};

p.retire_worker = function(pid, reason_data) {
	var worker = this.workers.get(pid);
	worker.removeAllListeners('request_retire');

	// sanitize reason data
	if (typeof reason_data === 'string') reason_data = {reason: reason_data};

	var reason = {};

	if (reason_data.reason)  reason.reason  = reason_data.reason;
	if (reason_data.details) reason.details = reason_data.details;

	this.retire_events.push(+new Date());

	if ('band' in worker) {
		// move worker from active band to old_workers pool
		this.worker_bands[ worker.band ] = null;
		worker.xband = worker.band;
		delete worker.band;
		this.old_workers.push(worker);
		// this will spin up a replacement
		this._spawn_band_worker(worker.xband);
	}

	// finally, we instruct worker to go into retirement mode
	worker.retire(reason);

	this.emit('retire', {
		worker: worker,
		reason: reason
	});
};

function handleWorkerPingTimeout(pid) {
	var worker = this.workers.get(pid);

	this.emit(
		'unresponsive',
		worker ? worker.getStats() : {pid: pid, missing: true}
	);
}

function destroyWorker(pid, reason, soft_kill_timeout) {
	var worker = this.workers.get(pid);

	if (!worker) return; // assume worker has already deleted!

	// destroy everything about this worker
	worker.terminate();

	// some manipulation for logging
	var msg = "Destroying process %d";

	if ('band' in worker) msg += "; band=" + worker.band;
	else if ('xband' in worker) msg += "; xband=" + worker.xband;
	msg += '; reason=%s'
	clog(msg, pid, reason);

	// an active worker is being destroyed
	// this is bad, we need to retire him immediately and spin a replacement
	if ('band' in worker) {
		// we specifically turn off graceful shutdown since we are doing a hard kill below
		// note: calling retire_worker() brings the workers to the old_workers array
		// we need to clean that up too below
		this.retire_worker(pid, {reason: reason});
	}

	// clean up after old workers
	var idx = this.old_workers.indexOf(worker);

	if (idx > -1) this.old_workers.splice(idx, 1);
	this.workers.del(pid);

	// do a hard kill on the process now
	killWorkerProcess(worker, soft_kill_timeout);
}

function killWorkerProcess(worker, soft_kill_timeout) {
	if (worker.killed)
		return; // worker is already scheduled to die

	worker.killed = true;

	return putil.kill( worker.pid, soft_kill_timeout )
		.fail(clog)
		.done();
}

var master_args = get_master_CLI_args(); // computed once now

function isWorkerCmd(cmd) {
	cmd = cmd.concat(); // make a local copy of the array

	// a worker has the same command line as the current process!
	if (cmd.shift() !== process.execPath) return false; // execPath was used when spawning children

	// workers *may* have more params, we care if all master params exist in the worker cli
	for (var idx = 0; idx < master_args.length; idx++) {
		if (cmd[idx] !== master_args[idx]) return false;
	}

	return true;
}

p.check_bands = function() {
	for (var band = this.worker_bands.length; band-- > 0;) {
		if (!this.worker_bands[band]) return;
		if (!this.worker_bands[band].connected) return;
	}

	// all bands are ready
	this.check_bands = noop;
	this.all_band_furnished_deferred.resolve();
};

// Refill workers
// Look through workers table and spawn new workers if there are gaps in iptables
// TODO: refill workers should not be so agressive in spinning multiple workers at once...
// TODO: instead stagger their launch with some delay or implement a queue system
p.refill_workers = function() {
	var _self = this, cur_band = this.worker_bands.length;

	function _do_refill_workers() {
		if (--cur_band < 0) return;
		_self._spawn_band_worker(cur_band);
		setTimeout(_do_refill_workers, _self.options.spawn_delay);
	}

	_do_refill_workers();

	return this.all_band_furnished_deferred.promise;
};

p._spawn_band_worker = function(band) {
	var args = get_master_CLI_args();

	args.push(band + ':' + this.options.num_workers);

	var env = util._extend({}, process.env);

	env.__ZWORKER__ = 'TRUE';
	env.__ZWORKER__BAND__ = band;
	env.__ZWORKER__NUM_WORKERS__ = this.options.num_workers;

	var child = spawn(process.execPath,
		args,
		{
			cwd:      undefined,
			detached: true,
			env:      env,
			stdio:    this.options.debug ? 'inherit' : 'ignore'
		}
	);
	clog("spawned new worker %d for band %d:%d", child.pid, band, this.options.num_workers);
	var worker = this.make_worker(child.pid);
	worker.band = band;
	this.worker_bands[band] = worker;
	worker.startConnectTimeout(); // new workers are expected to connect immediately

	// we only worry about retirement for fresh workers
	var _self = this;

	worker.once('request_retire', function(msg) {
		worker.reply({}, msg); // request ack
		_self.retire_worker(worker.pid, msg);
	});

	worker.once('connected', this.check_bands);

	return worker;
};

p.make_worker = function(pid) {
	var worker = new Worker(pid, {
		connect_timeout: this.options.connect_timeout,
		ping_timeout:    this.options.ping_timeout
	});

	worker.once('connect_timeout', destroyWorker.bind(this, pid, 'connect_timeout', 0));
	worker.once('disconnected',    destroyWorker.bind(this, pid, 'disconnected',    0));
	worker.once('ping_timeout',    this.handleWorkerPingTimeout);
	this.workers.set(pid, worker);

	return worker;
};

p.monitor_worker_pool = function() {
	if ( ! ('totalmaxheap' in this.options) || this.worker_monitor_IID)
		return;

	clog("setting up worker monitor at %ds interval", this.options.monitor_interval);
	this.worker_monitor_IID = setInterval(this._do_monitor_worker_pool.bind(this), this.options.monitor_interval);
};

p._do_monitor_worker_pool = function() {
	// get our own memory consumption first
	var
		worker, idx, rss,
		collected = {
			master: {mem: process.memoryUsage()},
			num_bands: this.worker_bands.length
		},
		cluster_rss = collected.master.mem.rss
	;

	// Aggregate the worker stats into a data structure that will be passed to emitted events
	// The function also returns the rss for that one worker
	function collect_worker_stats(worker, worker_type) {
		var stats;
		var band = ('band' in worker) ? worker.band : worker.xband;

		stats = worker.getStats();

		if (!('monitor_count' in stats))
			stats.monitor_count = 1;
		else
			stats.monitor_count++;

		// TODO: if a given stats object has been used to many times, something is wrong!

		if (!collected[band]) {
			collected[band] = {
				live: null, retired: []
			};
		}

		if (worker_type === 'live') {
			collected[band].live = stats;
		}
		else {
			collected[band].retired.push(stats);
		}

		var worker_rss = (stats && stats.mem && stats.mem.rss) || 0;

		cluster_rss += worker_rss;

		return worker_rss;
	}

	// Collect stats for all retired workers
	for (idx = this.old_workers.length; idx--; ) {
		worker = this.old_workers[idx];
		if (worker.timeout) {
			destroyWorker.call(this, worker.pid, "ping_timeout", 0);
			continue;
		}
		collect_worker_stats(worker, 'retired');
	}

	// Collect stats for all live workers
	// If a live worker's rss is above the worker low watermark threshold, it will be asked to retire
	for (idx = this.worker_bands.length; idx--; ) {
		worker = this.worker_bands[idx];
		rss = collect_worker_stats(worker, 'live');

		var retire_details = null;

		if (rss > this.options.worker_retire_rss) {
			retire_details = {
				reason: 'low watermark breach',
				details: {
					rss:       rss,
					threshold: this.options.worker_retire_rss
				}
			};
		}
		else if (worker.getStats().toobusy) {
			retire_details = {
				reason: 'too busy',
				details: {
					rss: rss
				}
			};
		}
		else if (worker.timeout) {
			this.emit('ping_timeout', worker.getStats());
			retire_details = 'ping_timeout';
		}

		if (retire_details) {
			this.rate_limited_retire_worker(worker.pid, retire_details);
		}
	}

	// all stats have been collected, pass them on to host app (if it's listening)
	this.emit('stats', collected);

	clog('Cluster health: %d:%d - mem: %s (watermarks: [%s, %s])',
		this.worker_bands.length,
		this.old_workers.length,
		frss(cluster_rss),
		frss(this.options.cluster_heap_low_watermark),
		frss(this.options.cluster_heap_high_watermark)
	);

	// TODO: if we are above watermarks but there are no retired workers to kill, the cluster settings are wrong and should be tweaked
	// TODO: An alert should be fired for that

	// if we're above high watermark, we kill as many workers as necessary to go below high watermark
	// and we'll get the remaining cluster rss
	if (cluster_rss > this.options.cluster_heap_high_watermark) {
		cluster_rss = handle_cluster_high_watermark.call(this, cluster_rss);
	}

	// if cluster rss is above low watermark, we check if any worker should be scheduled to die
	if (cluster_rss > this.options.cluster_heap_low_watermark) {
		handle_cluster_low_watermark.call(this, cluster_rss);
	}
	else {
		handle_cluster_ok.call(this, cluster_rss);
	}
};

function handle_cluster_ok(cluster_rss) {
	clog('OK: below LOW_WATERMARK: %s < %s',
		frss(cluster_rss),
		frss(this.options.cluster_heap_low_watermark)
	);

	/*
	this.emit('watermark_recovery', {
		live_count: this.worker_bands.length,
		retired_count: this.old_workers.length,
		rss: cluster_rss,
		threshold: this.options.cluster_heap_low_watermark
	});
	/**/
}

function handle_cluster_low_watermark(cluster_rss) {
	clog('WARNING: above LOW_WATERMARK: %s > %s',
		frss(cluster_rss),
		frss(this.options.cluster_heap_low_watermark)
	);

	var
		worker_stats,
		breach_data = {
			breach_rss: cluster_rss,
			of_old_workers: this.old_workers.length,
			workers: [],
			recovered_rss: 0
		};

	// we make a copy because the loops below will affect this.old_workers
	var old_workers_copy = this.old_workers.concat();

	// we now sort the workers from most killable to least
	// NOTICE: The kill strategy will always mark 'dying' workers as most killable first,
	// regardles of what the underlying strategy is. See method set_kill_strategy() above for details
	old_workers_copy.sort(this.kill_strategy);

	// We instruct the older workers that are completely above low watermark that they should die
	for (var idx = 0, len = old_workers_copy.length; idx < len; idx++) {
		var worker = old_workers_copy[idx];

		worker_stats = worker.getStats();

		if (cluster_rss - worker_stats.mem.rss <= this.options.cluster_heap_low_watermark) {
			// we've reached a worker that is either across or below low watermark
			// there's no more candidate to die
			break;
		}
		if (!worker.dying) {
			worker.die();
			breach_data.workers.push( worker_stats );
			breach_data.recovered_rss += worker_stats.mem.rss;
		}
		cluster_rss -= worker_stats.mem.rss;
	}

	breach_data.notified = breach_data.workers.length;

	if (breach_data.notified) {
		this.emit('low_watermark_breached', breach_data);
	}
}

function handle_cluster_high_watermark(cluster_rss) {
	clog('ALERT: HIGH_WATERMARK exceeded: %s > %s',
		frss(cluster_rss),
		frss(this.options.cluster_heap_high_watermark)
	);

	var
		old_rss = cluster_rss,
		worker_stats,
		breach_data = {
			breach_rss: cluster_rss,
			of_old_workers: this.old_workers.length,
			workers: []
		};

	// we make a copy because the loops below will affect this.old_workers
	var old_workers_copy = this.old_workers.concat();

	// we now sort the workers from most killable to least
	// NOTICE: The kill strategy will always mark 'timeout' and 'dying' workers as most killable first,
	// regardles of what the underlying strategy is. See method set_kill_strategy() above for details
	old_workers_copy.sort(this.kill_strategy);

	// We hard-kill some of the older workers to move memory usage below HIGH watermark
	for (var idx = 0, len = old_workers_copy.length; idx < len; idx++) {
		var worker = old_workers_copy[idx];

		worker_stats = worker.getStats();
		destroyWorker.call(this, worker.pid, "high_watermark_panic", 0);
		cluster_rss -= worker_stats.mem.rss;
		breach_data.workers.push( worker_stats );
		if (cluster_rss < this.options.cluster_heap_high_watermark) break;
	}

	breach_data.destroyed = breach_data.workers.length;
	breach_data.recovered_rss = old_rss - cluster_rss;

	if (breach_data.destroyed) {
		clog('Destroyed %d of %d old workers, freed %s MB RSS', breach_data.workers.length, old_workers_copy.length, frss(old_rss - cluster_rss));
	}

	this.emit('high_watermark_breached', breach_data);

	return cluster_rss;
}

function get_master_CLI_args() {
	return process.execArgv.concat(process.argv.slice(1));
}

function B2MB(num) {
	return num / 1024 / 1024;
}

function frss(rss) {
	return Math.round(B2MB(rss));
}

Master.ps = putil.ps;
