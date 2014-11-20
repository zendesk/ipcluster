module.exports = function(prefix) {
	return function() {
		var args = [].slice.call(arguments);

		if (typeof args[0] === 'string') {
			args[0] = prefix + ' ' + args[0];
		}
		else {
			args.unshift(prefix);
		}

		console.log.apply(this, args);
	}
};
