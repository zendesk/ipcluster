/* jshint -W103 */ // suppresses "The '__proto__' property is deprecated."

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
	net     = require('net'),
	util    = require('util'),
	events  = require('events'),
	toobusy = require('toobusy'),

	CommandProcessor = require('./CommandProcessor.js'),

	RECONNECT_INTERVAL = 50, // 50ms - completely arbitrary >.<
	PING_INTERVAL = 500, // 500ms

	STATES = {
		STARTING: 1,
		RUNNING:  2,
		SHUTDOWN: 3,
		DEAD:     4
	},

	default_options = {
		connect_timeout:  5000, // in ms
		toobusy_lag:      150,  // in ms
		toobusy_dampener: 10,   // only works wih recent toobusy

		health_check_delay: 45 // in s !!!
	};

function Worker(options, band) {
	events.EventEmitter.call(this);

	this.options = util._extend(util._extend({}, default_options), options);

	this.options.toobusy_lag = +this.options.toobusy_lag;
	toobusy.maxLag(this.options.toobusy_lag);

	this.options.toobusy_dampener = +this.options.toobusy_dampener;
	if (toobusy.dampeningFactor) {
		// old versions of toobusy do not expose dampeningFactor()
		toobusy.dampeningFactor(this.options.toobusy_dampener);
	}

	this.band = band;

	// socket variables
	this.disconnected = false;
	this.conn         = null;
	this.iface        = null;

	// timeout and interval variables
	this.reconnect_TID = null;
	this.ping_TID      = null;

	this.state = 'STARTING';
	this.ts_retirement = 0;

	this.connection_attempts = 0;

	process.on('SIGUSR1', SIG_warning);
	process.on('SIGUSR2', SIG_warning);

	// bind a few method to current instance now
	this.ping           = this.ping           .bind(this);
	this.request_retire = this.request_retire .bind(this);

	this._connect_to_master          = this._connect_to_master          .bind(this);
	this._connection_handler         = this._connection_handler         .bind(this);
	this._connection_error_handler   = this._connection_error_handler   .bind(this);
	this._disconnect_handler         = this._disconnect_handler         .bind(this);
	this._handshake_response_handler = this._handshake_response_handler .bind(this);
	this._info_handler               = this._info_handler               .bind(this);
	this._retire_handler             = this._retire_handler             .bind(this);
	this._die_handler                = this._die_handler                .bind(this);

	this._SIGUSR1_retire_handler     = this.request_retire              .bind(this, {reason: 'SIGUSR1'});

	this._connect_to_master();
}

function SIG_warning() {
	clog('Warning: received SIGNAL before being connected to master');
}

util.inherits(Worker, events.EventEmitter);

var p = Worker.prototype;

p._connect_to_master = function() {
	this.disconnected = false;

	// if (this.connection_attempts++ % 50 === 0) clog('Attempt %d to connect to master', this.connection_attempts);
	this.state = 'CONNECTING';
	this.conn = net.connect( this.options.uds );

	this.conn.once('error',   this._connection_error_handler);
	this.conn.once('connect', this._connection_handler);
};

p._schedule_reconnect_to_master = function() {
	if (this.reconnect_TID) {
		this.reconnect_TID = clearTimeout(this.reconnect_TID);
	}
	this.reconnect_TID = setTimeout(this._connect_to_master, RECONNECT_INTERVAL);
};

p._connection_handler = function() {
	clog('connected');
	this.state = 'CONNECTED';

	// connected successfully, remove listener for connection error
	this.removeListener('error', this._connection_error_handler);

	this.iface = new CommandProcessor(this.conn);
	this.iface.once('disconnected', this._disconnect_handler);

	process.removeListener('SIGUSR1', SIG_warning);
	process.removeListener('SIGUSR2', SIG_warning);

	process.on('SIGUSR1', this._SIGUSR1_retire_handler);
	process.on('SIGUSR2', this._die_handler);

	// to initiate handshake, send info packet
	// ( very primitive protocol >.< )
	clog('sending handshake info');
	this.iface.send('info', this.getInfo(), this._handshake_response_handler);
};

p._connection_error_handler = function() {
	this._destroy_connection();
	this._schedule_reconnect_to_master();
};

p._disconnect_handler = function() {
	if (this.disconnected) return;
	this.disconnected = true;

	this.state = 'DISCONNECTED';

	if (this.ping_TID) {
		this.ping_TID = clearInterval(this.ping_TID);
	}

	process.removeListener('SIGUSR1', this._SIGUSR1_retire_handler);
	process.removeListener('SIGUSR2', this._die_handler);

	process.on('SIGUSR1', SIG_warning);
	process.on('SIGUSR2', SIG_warning);

	this._destroy_iface();
	this._destroy_connection();

	this.connection_attempts = 0;

	// TODO fix the condition to prevent invalid reconnections
	if (this.state != STATES.SHUTDOWN && this.state != STATES.DEAD) {
		this._schedule_reconnect_to_master();
	}
};

p._destroy_connection = function() {
	if (!this.conn) return;
	this.conn.removeAllListeners();
	this.conn.destroy();
	this.conn = null;
};

p._destroy_iface = function() {
	if (!this.iface) return;
	this.iface.removeAllListeners();
	this.iface.destroy();
	this.iface = null;
};

p._handshake_response_handler = function() {
	// on handshake response, starts listening to incoming commands
	// TODO: verify response content!
	this.iface.on('__command_info',   this._info_handler);
	this.iface.on('__command_retire', this._retire_handler);
	this.iface.on('__command_die',    this._die_handler);

	// and set up ping process
	clog('PING_INTERVAL', PING_INTERVAL);
	this.ping_TID = setInterval(this.ping, PING_INTERVAL);
};

p._info_handler = function(msg) {
	clog('received info command');
	this.iface.reply(this.getInfo(), msg);
};

p._retire_handler = function(msg) {
	clog('received retire command');
	this.iface.reply({}, msg); // ok ack reply

	this.ts_retirement = +new Date();
	this.state = 'RETIRED';

	this.emit('command_retire', msg);  // inform host app
};

p._die_handler = function(msg) {
	clog('received die command');
	if (msg) this.iface.reply({}, msg); // ok ack reply
	this.emit('command_die', msg);  // inform host app
};

// ping event
p.ping = function() {
	this.iface.send('ping', this.getInfo());
};

// sends a message to the master
p.send = function(ztype, data, on_response) {
	return this.iface.send(ztype, data, on_response);
};

p.request = function(command, data, on_response) {
	return this.iface.request(command, data, on_response);
};

p.reply = function(data, parent_data, status) {
	return this.iface.reply(data, parent_data, status);
};

p.request_retire = function(data, on_response) {
	if (this.state === 'RETIRED') return;

	if (typeof data == 'string') data = {reason: data};
	if (!data) data = {};
	if (!data.reason) data.reason = 'unknown';

	return this.iface.request('retire', data, on_response);
};

// WARNING: Returns a promise
p.getInfo = function() {
	var info = {
		ts_sent: +new Date(),
		pid:     process.pid,
		mem:     process.memoryUsage(),
		toobusy: toobusy(),
		uptime:  process.uptime(),
		portmap: this.options.portmap,
		band:    this.band,
		conn:    {
			state:               this.state,
			connection_attempts: this.connection_attempts
		}
	};

	// we allow health_check_delay bootup time for the process to settle down
	// during that period, the process will report that it is healthy
	// this is to account for startup surge, and allow enough time for the garbage collector to reclaim some of the initialization memory
	if (process.uptime() <= this.options.health_check_delay) {
		info.toobusy = false;
		for (var key in info.mem) info.mem[key] = 1;
	}

	if (this.ts_retirement)
		info.ts_retirement = this.ts_retirement;

	// gather application-level info
	if (typeof(this.options.info_callback) === 'function') {
		try {
			info.app = this.options.info_callback();
		}
		catch(e) {
			info.app = {};
		}
	}

	return info;
};

// needs to be called by host app prior to exiting
p.shutdown = function() {
	toobusy.shutdown();
};

// ============================================================
// Module initialization
// ============================================================
var clog = require('./clogger')('[Worker.' + process.pid + ']');

module.exports = Worker;
clog('running');
