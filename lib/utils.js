module.exports = {
	once: once,
};

function once(fn) {
	var result;

	if (typeof fn !== 'function') {
		throw new TypeError('expect a function')
	}

	return function() {
		if (fn !== undefined) {
			result = fn.apply(this, arguments);
			fn = undefined;
		}

		return result;
	};
}
