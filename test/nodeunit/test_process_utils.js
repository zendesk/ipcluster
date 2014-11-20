var Q = require('q');
var process_util = require('../../lib/process_util');

exports.test_ps = function(test) {

	// getting memory stats for current process
	process_util.ps()

		.then(function( processes ) {
			test.ok(process.pid in processes, "current process not found in process list");
		})

 		.fail( test.ok.bind(test, false, "unable to get process list") ) // always fails
		.done( test.done );
};

exports.test_process_exists = function(test) {

	process_util.processExists( process.pid )

		.then(function( res ) {
			test.strictEqual(true, res, "current process isn't found");
		})

		.fail( test.ok.bind(test, false, "Unable to test process existence") ) // always fails
		.done( test.done );
};

exports.test_mem = function(test) {

	// getting memory stats for current process
	process_util.mem( process.pid )

		.then(function(mem_stats) {

			['Rss', 'Private', 'Shared', 'Pss', 'Swap']
				.forEach(function(field) {

					// field must exist
					test.ok(field in mem_stats, field + "is not in mem stats");

					// field must be an integer
					test.strictEqual(typeof mem_stats[field], 'number', field + "is not a number");
					test.strictEqual(mem_stats[field] % 1, 0, field + "is not an integer");
				});
		})

		.fail( test.ok.bind(test, false, "unable to compute mem stats") ) // always fails
		.done( test.done );
};

exports.test_startTimestamp = function(test) {

	var current_process_ts = null;

	process_util.startTimestamp( process.pid ) // checks current process first

		.then( function(timestamp) {

				test.strictEqual(typeof timestamp, 'number', "timestamp is not a number");
				test.ok(timestamp > 0, "timestamp is not positive");
				test.ok(timestamp < (+new Date()), "timestamp should be lower than now");

				current_process_ts = timestamp;
			}
		)
		.then( process_util.startTimestamp.bind(process_util, 1) ) // next check init process
		.then( function(timestamp) {
				test.ok(timestamp < current_process_ts, "process should be younger than init process")
			}
		)

		.fail( test.ok.bind(test, false, "unable to run test_startTimestamp test") ) // always fails
		.done( test.done );
};

exports.numSockets = {

	valid_response_type: function(test) {
		process_util.numSockets( process.pid )

			.then(function(num_sockets) {
				test.equal(typeof(num_sockets), 'number');
				test.ok(num_sockets >= 0);
			})

			.fail( test.ok.bind(test, false, "unable to run numSockets response test") ) // always fails
			.done( test.done );
	},

	socket_count: function(test) {

		var net = require('net');
		var old_num_sockets, server, conns = [];

		process_util.numSockets( process.pid )

			.then(function(num) {
				old_num_sockets = num;
			})

			.then(function() {
				// make a dummy server, we'll make a dummy connection to it afterwards!
				var deferred = Q.defer();
				server = net.createServer(function(conn){ conns.push(conn); });
				server.listen();
				server.on('listening', deferred.resolve);
				return deferred.promise;
			})

			.then(function() {
				return process_util.numSockets( process.pid );
			})

			.then(function(new_num_sockets) {
				// there's now a listening socket, so one over previous count
				test.equal(new_num_sockets, old_num_sockets + 1);
			})

			.then(function() {
				// connect to dummy server now
				var adr = server.address();
				var deferred = Q.defer();
				var conn = net.connect(adr.port, deferred.resolve);
				conns.push(conn);
				return deferred.promise;
			})

			.then(function() {
				return process_util.numSockets( process.pid );
			})

			.then(function(new_num_sockets) {
				// with a connection in, we have 2 ends, plus the listening socket still opened
				// so we expect 3 over the original count
				test.equal(new_num_sockets, old_num_sockets + 3);
			})

			.fail( function(err){
				console.log(err);
				test.ok(false, "cannot run numSockets socket_count test");
			})

			.then(function() {
				// cleanup
				conns.forEach(function(conn){ conn.destroy(); });
				conns = [];
				server.close();
			})

			.done( test.done );
	}
};
