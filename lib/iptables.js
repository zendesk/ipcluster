/*

IMPORTANT
---------
sudo iptables support is required.

Add to sudoers (visudo):
*/
// node ALL=(ALL) NOPASSWD: /sbin/iptables -t nat -L
// node ALL=(ALL) NOPASSWD: /sbin/iptables -t nat -[ID] PREROUTING -p tcp -m tcp -s 0.0.0.*/0.0.0.* -d * --dport 80 -j REDIRECT --to-ports ?????
// node ALL=(ALL) NOPASSWD: /sbin/iptables -t nat -[ID] PREROUTING -p tcp -m tcp -s 0.0.0.*/0.0.0.* -d * --dport 443 -j REDIRECT --to-ports ?????
// etc. for other ports
/*

Change node to the running user, venet0 to the network interface.

TODO: rethink the implications of allowing wildcards for -d, --dport, and
      check if -i should be omited.

Thankfully, iptables does not allow duplicate copies of most flags, so that
the * wildcards can't be abused (much). Nonetheless, sercurity feedback is
welcome.

*/

var
	assert  = require('assert'),
	exec    = require('child_process').exec,
	events  = require('events'),
	net     = require('net'),
	util    = require('util'),
	replace = require('./template').replace,

	CMD_IPTABLES = 'sudo -n /sbin/iptables -t nat',
	CMD_IPT_CMD  = {
		L: CMD_IPTABLES + ' -L PREROUTING -n',
		I: CMD_IPTABLES + ' -I PREROUTING -p tcp -m tcp -s 0.0.0.{slot}/0.0.0.{mask} -d {ip} --dport {from} -j REDIRECT --to-ports {to}',
		D: CMD_IPTABLES + ' -D PREROUTING -p tcp -m tcp -s 0.0.0.{slot}/0.0.0.{mask} -d {ip} --dport {from} -j REDIRECT --to-ports {to}'
	},
	CMD_TIMEOUT     = 1000,
	CMD_MAX_TRIES   = 5,
	CMD_RETRY_DELAY = 40
;

module.exports = IPTSet;

// Helper for cleaner regex construction
RegExp.prototype.toString = function() { return this.source };

/* iptables -L lines look like:
REDIRECT   tcp  --  0.0.0.0/0            0.0.0.0/0            tcp dpt:843 redir ports 20912
REDIRECT   tcp  --  0.0.0.0/0.0.0.7      123.45.67.89         tcp dpt:80 redir ports 10800
*/

var
	IP_PATTERN = '([\\d.]+)', // this is a weak match, use net.isIPv4
	R_IPT_ROW  = new RegExp('^' + [
		'REDIRECT',
		'tcp',
		'--',
		IP_PATTERN + '/' + IP_PATTERN,
		IP_PATTERN,
		'tcp dpt:(\\d+) redir ports (\\d+)'
	].join('\\s+') + '\\s*$');

function IPTSet(ip, slots, ports) {
	events.EventEmitter.call(this);

	// validate params
	if (!net.isIPv4(ip)) throw new Error('Bad ip: ' + ip);

	// smart re-arranging of arguments
	if (arguments.length === 2) {
		if (typeof(slots) !== 'number') {
			// slots is not a number, assumed to be an array representing the ports instead
			// swap slots and ports to capture which one is really undefined
			var tmp = slots;
			slots = ports;
			ports = tmp;
		}
	}

	// set up defaults
	if (typeof(slots) == 'undefined') slots = 4;
	if (typeof(ports) == 'undefined') ports = [80];

	if (!is_power_of_two(slots)) throw new Error('Bad slots; requiring power-of-2, ' + slots + ' provided');

	this.ip    = ip;
	this.slots = slots;
	this.ports = ports.sort();
	this.mask  = slots - 1;

	this.inflight = 0;       // number of adds / deletes in flight
	this.coverage   = {};    // mark slot when filled
	this.slots_left = slots; // subtract when slot is filled
}

util.inherits(IPTSet, events.EventEmitter);

IPTSet.parse = function(input, ip, ports) {
	var result = [];

	input.split(/[\r\n]+/).forEach(function(line) {
		var matches = line.match(R_IPT_ROW);
		if (!matches) return;
		if (matches[3] !== ip) return;
		if (ports.indexOf(+matches[4]) == -1) return;
		result.push([
			ip,
			parseInt(matches[1].split('.').pop(), 10),
			parseInt(matches[2].split('.').pop(), 10),
			parseInt(matches[4], 10),
			parseInt(matches[5], 10)
		]);
	});

	return result;
}

// Adds or updates port mapping for a slot
IPTSet.prototype.add = function(slot, port_map) {
	if (typeof slot == 'undefined' || slot > this.mask)
		throw new Error('Bad slot');

	if (!port_map || Object.keys(port_map).sort().join() != this.ports.join())
		throw new Error('Bad port');

	var from, to, i = 0;

	for (from in port_map) {
		to = port_map[from];
		this.inflight++;
		add_redirect(this.ip, slot, this.mask, from, to, done);
		i++;
	}

	var self = this;

	function done() {
		self.inflight--;
		if (--i) return;

		// update coverage
		if ( ! (slot in self.coverage) ) {
			self.slots_left--;

			if (!self.slots_left)
				log('All slots filled');
		}

		self.coverage[slot] = port_map;

		if (self.inflight) return;

		// no more outstanding commands, so cleanup and announce updated map
		self.cleanup(function() {
			setTimeout(function() { self.emit('change', self.coverage) }, 0);
		});
	}
}

// Delete unused rules
IPTSet.prototype.cleanup = function(cb) {
	if (this.slots_left) {
		// coverage not full
		cb && cb();
		return;
	}

	var self = this;
	list_rules(this.ip, this.ports, function(rules) {
		var count = 0;

		for (var i = 0; i < rules.length; i++) {
			var rule = rules[i], active_map = self.coverage[rule.slot];

			if (!active_map || active_map[rule.from] != rule.to) {
				count++;
				del_redirect(rule.ip, rule.slot, rule.mask, rule.from, rule.to, done);
			}
		}

		log('Deleting', count, 'unused rules');

		function done() { if (!--count) cb && cb() }

		if (!count) cb && cb();
	});
}

// Delete all associated rules
IPTSet.prototype.flush = function(cb) {
	this.coverage = {}
	this.slots_left = 0;
	this.cleanup(cb);
	this.slots_left = this.slots;
}

function add_redirect(ip, slot, mask, from, to, cb) {
	run_iptables_command('I', ip, slot, mask, from, to, cb);
}

function del_redirect(ip, slot, mask, from, to, cb) {
	run_iptables_command('D', ip, slot, mask, from, to, cb);
}

function list_rules(ip, ports, cb) {
	run_iptables_command('L', function(stdout) {

		var rules = IPTSet.parse(stdout, ip, ports);

		rules = rules.map(function(rule) { return {
			ip:   rule[0],
			slot: rule[1],
			mask: rule[2],
			from: rule[3],
			to:   rule[4]
		} });

		cb && cb(rules);
	});
}

function run_iptables_command(command, ip, slot, mask, from, to, cb) {
	switch (command) {
		case 'I':
		case 'D':
			assert.ok(net.isIPv4(ip));
			assert.equal(typeof slot, 'number');
			assert.equal(typeof mask, 'number');
			from = parseInt(from, 10);
			to   = parseInt(to  , 10);
			assert.ok( from > 0 && from < 65536 );
			assert.ok( to   > 0 && to   < 65536 );
			break;

		case 'L':
			cb = ip;
			break;

		default: throw 'Bad iptables command'
	}

	var cmd = replace(CMD_IPT_CMD[command], {
		slot: slot,
		mask: mask,
		ip:   ip,
		from: from,
		to:   to
	});

	queue_exec(cmd, cb);
}

var exec_queue = [], exec_lock;

function queue_exec(cmd, cb) {
	exec_queue.push([cmd, cb, CMD_MAX_TRIES]);

	if (!exec_lock)
		exec_next();
}

function exec_next() {
	if (!exec_queue.length) {
		exec_lock = 0;
		return;
	}

	exec_lock = 1;

	var
		item       = exec_queue.shift(),
		cmd        = item[0],
		cb         = item[1],
		tries_left = item[2];

	log('  >', cmd);

	exec(cmd, { timeout: CMD_TIMEOUT }, function(error, stdout /*, stderr */) {
		if (error) {
			// Warning: iptables doesn't have exhaustive return codes
			// Failure reason is in the stderr message instead, and so we must do a string comparison
			// Note: [^]+ matches any character including newline
			if (/ -D PREROUTING [^]+ No chain.target.match by that name/i.test(error + '')) {
				// Trying to delete a rule that's not there
				// Something is "weird", but it should not be a blocking error
				// TODO: investigate how/why this might happen
				log('Warning: Attempting to delete a rule that\'s not present');
			}
			else {
				// Real error that's worth retrying or reporting
				log('Warning: cannot run command: ' + cmd + '; ' + error);

				if (--tries_left > 0) {
					exec_queue.unshift([cmd, cb, tries_left]);
					setTimeout(exec_next, CMD_RETRY_DELAY * (CMD_MAX_TRIES - tries_left));
					return;
				}
				/*
				else {
					// There's no tries left but the command still cannot execute (for some reason?)
					// We used to throw here, but that would cause exec_lock to never be reset and lock the master up entirely.
					// We now do nothing ON PURPOSE. The current failed command might prevent one worker to work correctly,
					// but the master overall will carry on.
					// TODO: find out why/when/how can iptables commands fail
				}
				/**/
			}
		}

		cb && cb(stdout || '');
		setTimeout(exec_next, CMD_RETRY_DELAY);
	});
}

function is_power_of_two(n) {
	return (n !== 0) && ((n & (n - 1)) === 0);
}

function log() { IPTSet.log && IPTSet.log.apply(null, arguments) }
