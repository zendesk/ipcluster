var 
	fs      = require('fs'),
	exec    = require('child_process').exec,
	Q       = require('q'),
	replace = require('./template').replace;

module.exports = {
	ps:             ps,
	getCommand:     getCommand,
	processExists:  processExists,
	getEnv:         getEnv,
	numSockets:     numSockets,
	kill:           kill,
	renice:         renice,
	mem:            mem,
	startTimestamp: startTimestamp
};

function ps() {
	return Q.nfcall(fs.readdir, '/proc')

		.then(function(entries) {
			return Q.allSettled(
				entries
					.filter(function(p) { return +p > 1; } )
					.map( getCommand )
			);
		})

		.then(function(results) {
			var processes = {};
			results.forEach( function(result) {
				if (result.state !== 'fulfilled') return;
				processes[result.value[0]] = result.value[1];
			});
			return processes;
		})

		.fail(function(err){
			console.log(err);
			return {};
		});
}

function getCommand(pid) {
	return Q.nfcall(fs.readFile, replace('/proc/{pid}/cmdline', {pid: pid}))
		.then(function(res) {
			return [pid, res.toString().split('\x00')];
		});
}

function processExists(pid) {
	// Note: processExists canNOT use Q.nfcall() because the callback
	// for fs.exists() doesn't pass an error object as first argument (only true/false)
	var deferred = Q.defer();
	fs.exists('/proc/' + pid, deferred.resolve);
	return deferred.promise;
}

function numSockets(pid) {
	var base_path = replace('/proc/{pid}/fd', {pid: pid});

	return Q.nfcall(fs.readdir, base_path)

		.then(function(entries) {
			// call readlink on ALL entries in fd folder (even non-links! we'll deal with errors later)
			return Q.allSettled(
				entries.map(function(name) {
					return Q.nfcall(fs.readlink, base_path + '/' + name);
				})
			);
		})

		.then(function(link_promises) {
			var num_sockets = 0;
			link_promises.forEach(function(link_promise) {
				var val = link_promise.value;
				if (val && val.indexOf && val.indexOf('socket:') === 0) {
					num_sockets += 1;
				}
			});
			return num_sockets;
		});
}

function getEnv(pid) {
	return Q.nfcall(fs.readFile, replace('/proc/{pid}/environ', {pid: pid}))
		.then(function(res) {
			var env = {};
			res.toString().split('\x00').forEach(function(pair) {
				var eq_idx = pair.indexOf('=');
				env[pair.substr(0, eq_idx)] = pair.substr(eq_idx + 1);
			});
			return env;
		});
}

function kill(pid, term_timeout) {
	if (pid < 0) return;

	function hardkill() {
		process.kill(pid, 'SIGKILL'); // hard kill!
	}

	if (!term_timeout) {
		// term_timeout is undefined, that means we do a hard kill NOW!
		return Q.fcall( hardkill )
			.fail( ignore_missing_process_error );
	}
	else {
		return Q.fcall(function() {
				process.kill(pid, 'SIGTERM'); // soft kill
				return [pid, term_timeout];
			})
			.spread( waitForProcessToDie )
			.fail( ignore_missing_process_error )
			.fail( hardkill )
			.fail( ignore_missing_process_error );
	}
}

function ignore_missing_process_error(err) {
	if (err.code === 'ESRCH') return; // "No such process" (=== Already gone! Yay!)
	else throw err;
}

function waitForProcessToDie(pid, die_timeout) {
	var expire_at = (+new Date()) + die_timeout;

	var deferred = Q.defer();

	function cycle_check() {
		processExists(pid)
			.then(function(exists) {
				if (exists) {
					if ((+new Date()) >= expire_at) {
						deferred.reject( pid ); // process didn't die within allocated time
					}
					else {
						process.nextTick( cycle_check ); // still have time, check again at next cycle
					}
				}
				else {
					deferred.resolve( pid );
				}
			})
			.done();
	}

	process.nextTick( cycle_check );

	return deferred.promise;
}

function renice(pid, value) {
	var deferred = Q.defer(), cmd;

	if (
		typeof value === 'number'
		&& (value % 1 === 0) // is int
		&& (value >= -20)
		&& (value <=  20)
	) {
		cmd = replace('renice -n {value} -p {pid}', {
			pid:   pid,
			value: value
		});

		exec(cmd, function(err /*, stdout, stderr */) {
			if (err) {
				deferred.reject(err);
				return;
			}
			deferred.resolve();
		});
	}
	else {
		deferred.reject({code: 'BAD_VALUE', value: value});
	}

	return deferred.promise;
}

var mem_smap_location = '/proc/{pid}/smaps';
var mem_stat_re = /^([a-z]+)(_[a-z]+)?:\s+(\d+)\s+kb\s*$/i;
var eol_re = /[\r\n]+/;
function mem(pid) {
	var deferred = Q.defer();

	var smaps_file = replace(mem_smap_location, {pid: pid});

	fs.readFile(smaps_file, "utf-8", function(error, text) {

		if (error) {
			deferred.reject(new Error(error));
			return;
		}

		var res = {};

		text.split( eol_re ).forEach(function(line) {
			var match = line.match(mem_stat_re);
			if (!match) return;
			var mem_type = match[1];

			if (! (mem_type in res)) res[mem_type] = 0;

			res[mem_type] += (parseInt(match[3], 10) * 1024); // converts to bytes
		});

		deferred.resolve( res );
	});

	return deferred.promise;
}

function startTimestamp(pid) {
	var deferred = Q.defer();

	Q.nfcall(fs.stat, replace('/proc/{pid}', {pid: pid}))
		.then(function(stat) {
				deferred.resolve( stat.mtime.getTime() );
			}, deferred.reject)
		.done();

	return deferred.promise;
}
