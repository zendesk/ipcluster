module.exports = CommandProcessor;

// Helpers
var
	events = require('events'),
	util   = require('util'),
	clog   = require('./clogger')('[CommandProcessor.' + process.pid + ']'),
	once   = require('./utils').once,
	noop   = function() {};

// var RESPONSE_TIMEOUT = 500; // 500ms is already *very* long for a UDS local system

function CommandProcessor(conn) {
	events.EventEmitter.call(this);

	this.conn = conn;

	this.connected_at = +new Date();
	this.last_data_at = 0;
	this.last_ping_at = 0;

	p.data_timeout = -1; // disabled
	p.data_timeout_TID = null;

	p.ping_timeout = -1; // disabled
	p.ping_timeout_TID = null;

	this._request_id = 0;
	this._requests_in_flight = {};

	this.last_line   = '';

	// handling disconnection can only be done once
	var _handle_disconnection = once(this._handle_disconnection.bind(this));

	conn.on('data',  this.process_data.bind(this));
	conn.on('error', _handle_disconnection);
	conn.on('end',   _handle_disconnection); // Do we really need this?
	conn.on('close', _handle_disconnection);

	// bind some methods to current instance for easy reuse
	this._emit_data_timeout = this._emit_data_timeout .bind(this);
	this._emit_ping_timeout = this._emit_ping_timeout .bind(this);
	this.set_timeouts();
}

util.inherits(CommandProcessor, events.EventEmitter);

var p = CommandProcessor.prototype;

p.process_data = function(chunk) {
	var lines, i, m, json, __messageID;

	// before we process, every packet we receive should update the last ping time
	this._update_last_data();

	lines = chunk.toString().split(/[\r\n]+/);
	lines[0] = this.last_line + lines[0];
	m = lines.length - 1;

	for (i = 0; i < m; i++) {
		try {
			json = JSON.parse(lines[i]);
		}
		catch(e) {
			dump('Bad JSON', lines[i]);
			continue;
		}

		if (json.__type == 'response') {
			do {
				__messageID = json.__messageID;

				if (!__messageID) {
					dump('No message ID in response', json);
					break;
				}

				if (json.__status != 'ok') {
					clog('Failed request or command: response details: ', json);
					if (__messageID in this._requests_in_flight) {
						clog('Request details: ', JSON.stringify(this._requests_in_flight[__messageID].msg));
					}
				}

				if (__messageID in this._requests_in_flight) {
					if (this._requests_in_flight[__messageID].callback) {
						try {
							this._requests_in_flight[__messageID].callback( json );
						}
						catch(e) {} // eslint-disable-line no-empty
					}

					delete this._requests_in_flight[__messageID];
				}
				else {
					dump('Bad message ID', json);
					break;
				}
			}
			while(false); // eslint-disable-line no-constant-condition
		}

		try {
			this._process_message(json);
		}
		catch(e) {
			dump('Error processing message', e);
			dump('Server message was', json);
		}
	}

	this.last_line = lines[m];
};

p.send = function(ztype, data, on_response) {
	var
		id,
		msg_obj = util._extend({}, data);

	msg_obj.__type = ztype;

	if (on_response) {
		id = ++this._request_id;
		msg_obj.__messageID = id;
		this._requests_in_flight[id] = {msg: msg_obj, callback: on_response};
	}

	try {
		this.conn.write(JSON.stringify(msg_obj) + "\n");
	}
	catch(e) {
		clog('Unable to write to socket');
		if (id) {
			delete this._requests_in_flight[id];
		}
	}
};

p.command = function(command, data, on_response) {
	data = util._extend({}, data);
	data.__cmd = command;
	this.send('command', data, on_response || noop);
};

p.request = function(request, data, on_response) {
	data = util._extend({}, data);
	data.__request = request;
	this.send('request', data, on_response || noop);
};

p.reply = function(data, parent_data, status) {
	data = util._extend({}, data);
	if ('__messageID' in parent_data) data.__messageID = parent_data.__messageID;
	data.__status = status || 'ok';

	this.send('response', data);
};

// called on either end/error/close event on the UDS socket
p._handle_disconnection = function(arg) {
	clog('disconnected: ' + arg);
	this.emit('disconnected', arg);
	this.destroy();
};

p._process_message = function(msg_obj) {
	if (msg_obj.__type === 'ping') {
		this._update_last_ping();
	}

	// we fire multiple event in the same message so as to allow listening at different level of granularity

	this.emit(msg_obj.__type, msg_obj);

	if (msg_obj.__type === 'request') {
		if ( ! ('__request' in msg_obj) ) {
			clog('invalid request received: ' + JSON.stringify(msg_obj));
		}
		else {
			// TODO: __request needs to be sanitized before broadcasting
			clog('received request ' + msg_obj.__request);
			this.emit('__request_' + msg_obj.__request, msg_obj);
		}
	}
	else if (msg_obj.__type === 'command') {
		if ( ! ('__cmd' in msg_obj) ) {
			clog('invalid command received: ' + JSON.stringify(msg_obj));
		}
		else {
			// TODO: __cmd needs to be sanitized before broadcasting
			clog('received command ' + msg_obj.__cmd);
			this.emit('__command_' + msg_obj.__cmd, msg_obj);
		}
	}

	this.emit('__message', msg_obj);
};

p.set_timeouts = function(data_timeout, ping_timeout) {
	this.data_timeout = (data_timeout && data_timeout > 0) ? data_timeout : -1;
	this.ping_timeout = (ping_timeout && ping_timeout > 0) ? ping_timeout : -1;

	this._update_data_timeout();
	this._update_ping_timeout();
};

p.destroy = function() {
	this.removeAllListeners();
	this.set_timeouts();

	if (this.conn) {
		this.conn.removeAllListeners();
		this.conn.destroy();
		this.conn = null;
	}
};

p._update_last_data = function() {
	this.last_data_at = +new Date();
	this._update_data_timeout();
};

p._update_data_timeout = function() {
	if (this.data_timeout_TID) {
		this.data_timeout_TID = clearTimeout(this.data_timeout_TID);
	}
	if (this.data_timeout > 0) {
		this.data_timeout_TID = setTimeout( this._emit_data_timeout, this.data_timeout);
	}
};

p._emit_data_timeout = function() {
	this.emit('__data_timeout', this.last_data_at);
};

p._update_last_ping = function() {
	this.last_ping_at = +new Date();
	this._update_ping_timeout();
};

p._update_ping_timeout = function() {
	if (this.ping_timeout_TID) {
		this.ping_timeout_TID = clearTimeout(this.ping_timeout_TID);
	}
	if (this.ping_timeout > 0) {
		this.ping_timeout_TID = setTimeout( this._emit_ping_timeout, this.ping_timeout);
	}
};

p._emit_ping_timeout = function() {
	this.emit('__ping_timeout', this.last_ping_at);
};

function dump(str, o) {
	o && (str += ' ' + util.inspect(o).replace(/\n/g, ''));
	clog(str);
}
