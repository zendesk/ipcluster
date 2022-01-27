var utils = process.env.WITH_COVERAGE ?
	require('../../lib-cov/utils') :
	require('../../lib/utils');

exports.test_once_throws = function(test) {
	test.throws(function() { utils.once(1) }, 'expect a function');
	test.done();
}

exports.test_once_once = function(test) {
	var count = 0;
	function a() {
		return ++count;
	}

	var onced_a = utils.once(a);

	test.strictEqual(count, 0, 'should not invoke fn on its own');

	var result1 = onced_a();

	test.strictEqual(count, 1, 'wrapped function should invoke fn');
	test.strictEqual(result1, 1, 'wrapped function should return result from invoking fn');

	onced_a();

	test.strictEqual(count, 1, 'wrapped function should invoke fn at most once');

	a();

	test.strictEqual(count, 2, 'fn should be called twice');

	var result3 = onced_a();

	test.strictEqual(result3, 1, 'wrapped function should return initial result');

	test.done();
}

exports.test_this = function(test) {
	var
		a = utils.once(function() { return ++this.count }),
		obj = { 'a': a, 'count': 0 }
	;

	test.strictEqual(obj.count, 0);

	var result1 = obj.a();

	test.strictEqual(obj.count, 1);
	test.strictEqual(result1, 1);

	var result2 = obj.a();

	test.strictEqual(obj.count, 1);
	test.strictEqual(result2, 1);

	test.done();
}
