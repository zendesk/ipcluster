module.exports = {
	replace: replace
};

function replace(template, params) {
	return template.replace(/\{([^}]+)\}/g, function(match, param) {
		return params[param];
	});
}

