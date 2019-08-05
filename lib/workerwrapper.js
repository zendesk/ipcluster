/*
	either enscapsulates a worker for server to control
	or does the actual workery things

	new Worker(existing_commandline);
		returns a worker object to control an existing worker process

	new Worker(slot, slots);
		spawns off a new worker with the same commandline arguments
		as master, except --master is replaced with --worker slot/slots

*/

var
	util   = require('util'),
	events = require('events'),
	STATES = {
		STARTING: 1,
		RUNNING:  2,
		SHUTDOWN: 3,
		DEAD:     4
	};

// ============================================================
// WorkerWrapper class to be used by master
// ============================================================

var default_options = {
	connect_timeout: 1500,
	ping_timeout:    2500
};

function WorkerWrapper(pid, options) {
	events.EventEmitter.call(this);

	this.options = util._extend(util._extend({}, default_options), options);

	this.pid = pid;
	this.state = 'STARTING';
	this.connected = false;
	this.connect_timeout_TID = null;
	this.command_queue = [];

	this.timeout = false;
	this.dying   = false;

	// fake stats at initialization
	this.stats = {
		ts_sent:     +new Date(),
		ts_received: +new Date(),
		t_travel:    0,
		t_ping_diff: 0,
		pid:         pid,
		mem:         {rss: 0},
		toobusy:     false,
		portmap:     {},
		app:         {},
		uptime:      0,
		band:        -1
	};

	this.setStats = this.setStats.bind(this);
	this._handlePingTimeout = this._handlePingTimeout.bind(this);

	this._clearInterface();
}

// public enum
WorkerWrapper.STATES = STATES;

var p = WorkerWrapper.prototype;
p.__proto__ = events.EventEmitter.prototype;

// dummy api functions until a connection is established
function api_default() {
	clog('ERROR: transmission without connection');
}

p.setStats = function(stats) {
	// TODO: validate stats object?

	// record additional meta information about the worker stats
	stats.ts_received = +new Date();
	stats.t_ping_diff = stats.ts_received - this.stats.ts_received;
	stats.t_travel    = stats.ts_received - stats.ts_sent; // because Dates are consistent accross processes of the same physical box

	this.stats = stats;
};

p.getStats = function() {
	return this.stats;
};

p.startConnectTimeout = function() {
	if (this.connect_timeout_TID) {
		this.connect_timeout_TID = this.clearTimeout(this.connect_timeout_TID);
	}

	// connection is considered established when a command processor is provided
	// if one is already present, we don't need a connect timeout
	if (!this.command_processor) {
		this.connect_timeout_TID = setTimeout( this.emit.bind(this, 'connect_timeout', this.pid), this.options.connect_timeout );
	}
};

p.setProcessor = function(processor) {
	// connection is now considered established
	this.command_processor = processor;
	this.connected = true;
	this.state = 'CONNECTED';

	if (this.connect_timeout_TID) {
		this.connect_timeout_TID = clearTimeout( this.connect_timeout_TID );
	}

	this.removeAllListeners('connect_timeout');

	// binding the interface as pass-through to the command processoressor
	this.reply        = processor.reply        .bind(processor);
	this.set_timeouts = processor.set_timeouts .bind(processor);

	processor.set_timeouts(-1, this.options.ping_timeout);
	processor.once('__ping_timeout', this._handlePingTimeout);
	processor.on  ('ping',           this.setStats);
	processor.once('disconnected',   this.emit.bind(this, 'disconnected'));

	// handles incoming requests.
	processor.on('__request_retire', this.emit.bind(this, 'request_retire'));

	// clear the command queue (if any)
	this._flush_command_queue();

	// notify whoever cares
	this.emit('connected');
};

p._resetPingTimeout = function() {
	// Dang it! this is a private method >.<
	this.command_processor._update_last_ping();
	this.timeout = false;
};

p._handlePingTimeout = function() {
	var
		_self = this,
		info_TID;

	// attempt to query worker to see if it responds to commands
	this.command('info', {}, function(info) {
		clearTimeout(info_TID);
		_self.setStats(info);
		_self.command_processor.once('__ping_timeout', _self._handlePingTimeout);
		_self._resetPingTimeout();
	});

	// we implement a info response timeout, which is much longer
	info_TID = setTimeout(
		function() {
			_self.timeout = true;
			_self.emit('ping_timeout', _self.pid);
		},
		this.options.ping_timeout
	);
};

p.terminate = function() {
	this.removeAllListeners();
	this._clearInterface();

	this.connected = false;
	this.command_queue = [];

	if ( this.connect_timeout_TID ) this.connect_timeout_TID = clearTimeout( this.connect_timeout_TID );
	if ( this.command_processor )   this.command_processor.destroy();

	this.command_processor = null;
};

p._flush_command_queue = function() {
	if (!this.command_processor) return;

	for (var idx = 0; idx < this.command_queue.length; idx++) {
		var args = this.command_queue[idx];
		this.command_processor.command(args[0], args[1], args[2]);
	}

	this.command_queue = [];
};

p.command = function(cmd, data, on_response) {
	this.command_queue.push([cmd, data, on_response]);
	this._flush_command_queue();
};

p.retire = function(reason) {
	this.state = 'RETIRED';
	this.command('retire', reason);
};

p.die = function() {
	if (this.dying) return;
	this.dying = true;
	this.state = 'KILLING';
	this.command('die');
};

p.recover = function() {
	delete this.dying;
	this.command('recover');
};

p._clearInterface = function() {
	this.reply = this.set_timeouts = api_default;
	this.command_processor = null;
};

// ============================================================
// Module initialization
// ============================================================
var clog = require('./clogger')('[WorkerWrapper' + process.pid + ']');

module.exports = WorkerWrapper;
