var IPTSet = process.env.WITH_COVERAGE ?
	require('../../lib-cov/iptables') :
	require('../../lib/iptables');

IPTSet.log = console.log;

exports.test_parse = function(test) {
	var FAKE_INPUT = [
		'Chain PREROUTING (policy ACCEPT)',
		'target     prot opt source               destination',
		'REDIRECT   tcp  --  0.0.0.0/0            0.0.0.0/0            tcp dpt:843 redir ports 20912 ',
		'REDIRECT   tcp  --  0.0.0.0/0.0.0.7      107.6.117.59         tcp dpt:80 redir ports 10800 ',
		'REDIRECT   tcp  --  0.0.0.1/0.0.0.7      107.6.117.59         tcp dpt:80 redir ports 10801 ',
		'REDIRECT   tcp  --  0.0.0.2/0.0.0.7      107.6.117.59         tcp dpt:80 redir ports 10802 ',
		'REDIRECT   tcp  --  0.0.0.3/0.0.0.7      107.6.117.59         tcp dpt:80 redir ports 10803 ',
		'REDIRECT   tcp  --  0.0.0.4/0.0.0.7      107.6.117.59         tcp dpt:80 redir ports 10810 ',
		'REDIRECT   tcp  --  0.0.0.5/0.0.0.7      107.6.117.59         tcp dpt:80 redir ports 10811 ',
		'REDIRECT   tcp  --  0.0.0.6/0.0.0.7      107.6.117.59         tcp dpt:80 redir ports 10812 ',
		'REDIRECT   tcp  --  0.0.0.7/0.0.0.7      107.6.117.59         tcp dpt:80 redir ports 10813 ',
		'REDIRECT   tcp  --  0.0.0.0/0.0.0.7      107.6.117.59         tcp dpt:443 redir ports 44300 ',
		'REDIRECT   tcp  --  0.0.0.1/0.0.0.7      107.6.117.59         tcp dpt:443 redir ports 44301 ',
		'REDIRECT   tcp  --  0.0.0.2/0.0.0.7      107.6.117.59         tcp dpt:443 redir ports 44302 ',
		'REDIRECT   tcp  --  0.0.0.3/0.0.0.7      107.6.117.59         tcp dpt:443 redir ports 44303 ',
		'REDIRECT   tcp  --  0.0.0.4/0.0.0.7      107.6.117.59         tcp dpt:443 redir ports 44310 ',
		'REDIRECT   tcp  --  0.0.0.5/0.0.0.7      107.6.117.59         tcp dpt:443 redir ports 44311 ',
		'REDIRECT   tcp  --  0.0.0.6/0.0.0.7      107.6.117.59         tcp dpt:443 redir ports 44312 ',
		'REDIRECT   tcp  --  0.0.0.7/0.0.0.7      107.6.117.59         tcp dpt:443 redir ports 44313 ',
		'REDIRECT   tcp  --  0.0.0.0/0            107.6.117.60         tcp dpt:80 redir ports 8888 ',
		'REDIRECT   tcp  --  0.0.0.0/0            107.6.117.60         tcp dpt:443 redir ports 44443 ',
		'REDIRECT   tcp  --  0.0.0.3/0.0.0.3      1.2.3.4             tcp dpt:443 redir ports 12345 '
	].join('\n');

	var iptables_entries = IPTSet.parse(FAKE_INPUT, '107.6.117.59', [80, 443]);

	test.deepEqual(iptables_entries, [
		['107.6.117.59', 0, 7, 80, 10800],
		['107.6.117.59', 1, 7, 80, 10801],
		['107.6.117.59', 2, 7, 80, 10802],
		['107.6.117.59', 3, 7, 80, 10803],
		['107.6.117.59', 4, 7, 80, 10810],
		['107.6.117.59', 5, 7, 80, 10811],
		['107.6.117.59', 6, 7, 80, 10812],
		['107.6.117.59', 7, 7, 80, 10813],
		['107.6.117.59', 0, 7, 443, 44300],
		['107.6.117.59', 1, 7, 443, 44301],
		['107.6.117.59', 2, 7, 443, 44302],
		['107.6.117.59', 3, 7, 443, 44303],
		['107.6.117.59', 4, 7, 443, 44310],
		['107.6.117.59', 5, 7, 443, 44311],
		['107.6.117.59', 6, 7, 443, 44312],
		['107.6.117.59', 7, 7, 443, 44313]
	]);

	test.done();
}

exports.test_init = function(test) {
	test.throws(function() { new IPTSet('1.2.3.4', 6, [80]) }, 'Slots not power of 2');
	test.throws(function() { new IPTSet(                  ) }, 'Bad IP');
	test.throws(function() { new IPTSet('moo.com', 8, [80]) }, 'Bad IP');

	test.doesNotThrow(function() { new IPTSet('1.2.3.4'      ) }, 'Test defaults');
	test.doesNotThrow(function() { new IPTSet('1.2.3.4', 4   ) }, 'Test defaults');
	test.doesNotThrow(function() { new IPTSet('1.2.3.4', [80]) }, 'Test defaults');

	test.done();
}

exports.test_interface = function(test) {
	var ipt_set = new IPTSet('1.2.3.4', 4, [80, 443]);

	test.throws(function() { ipt_set.add(                            ) }, 'Bad slot');
	test.throws(function() { ipt_set.add(4, { 80: 12345, 443: 12346 }) }, 'Bad slot');
	test.throws(function() { ipt_set.add(3, { 80: 12345, 444: 12345 }) }, 'Bad port');
	test.throws(function() { ipt_set.add(3, { 80: 12345             }) }, 'Missing port');
	test.throws(function() { ipt_set.add(3                           ) }, 'Missing port');

	var check;

	ipt_set.on('change', function(state) { check(state) });

	test_three_quarters();

	function test_three_quarters() {
		ipt_set.add(0, { 80: 10080, 443: 10443 });
		ipt_set.add(1, { 80: 14080, 443: 14443 }); // whoops?
		ipt_set.add(2, { 80: 12080, 443: 12443 });

		check = function(state) {
			test.deepEqual(state, [
				{ 80: 10080, 443: 10443 },
				{ 80: 14080, 443: 14443 },
				{ 80: 12080, 443: 12443 }
			]);

			test_full_coverage();
		};
	}

	function test_full_coverage() {
		ipt_set.add(3, { 80: 13080, 443: 13443 });

		check = function(state) {
			test.deepEqual(state, [
				{ 80: 10080, 443: 10443 },
				{ 80: 14080, 443: 14443 },
				{ 80: 12080, 443: 12443 },
				{ 80: 13080, 443: 13443 }
			]);

			test_replace_slot();
		};
	}

	function test_replace_slot() {
		ipt_set.add(1, { 80: 11080, 443: 11443 }); // whew!

		check = function(state) {
			test.deepEqual(state, [
				{ 80: 10080, 443: 10443 },
				{ 80: 11080, 443: 11443 },
				{ 80: 12080, 443: 12443 },
				{ 80: 13080, 443: 13443 }
			]);

			ipt_set.flush(test.done);
		};
	}
}
