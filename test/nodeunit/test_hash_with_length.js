var Hash = require('../../lib/HashWithLength');

exports.test_iteration = function(test) {

	var h = new Hash();
	var pid = 0;

	h.set(++pid, {name: 'foo'});
	h.set(++pid, {name: 'bar'});
	h.set(++pid, {name: 'baz'});

	var names_map = {};

	h.for_each(function(obj) {
		names_map[obj.name] = 1;
	});

	test.deepEqual(names_map, {foo:1, bar:1, baz:1});

	test.done();
}