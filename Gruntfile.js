module.exports = function(grunt) {

  // Project configuration.
  grunt.initConfig(
  {
    pkg: grunt.file.readJSON('package.json'),
    
    jshint: 
    {
      options: 
      {
        /* environment flags */
        node:        true,  /* because this is a node js project (duh!) */
        nonstandard: true,  /* This option defines non-standard but widely adopted globals such as escape and unescape. */ 

        /* syntax agreement flags */
        strict:      false, /* because we rock */
        laxbreak:    true,  /* allow multi-line expression with operator first */
        laxcomma:    true,  /* allow comma-first style */
        smarttabs:   true,  /* allow leading tabs folloed by spaces */
        asi:         true,  /* suppresses warnings about missing semicolon */
        lastsemic:   true,  /* suppresses warnings about missing semicolon */
        expr:        true,  /* suppresses warnings about expressions where assignment or function call expected */
        sub:         true,  /* suppresses dot notation warnings */
        newcap:      false, /* do not require that class names start with upper case character */
        undef:       true,  /* prohibits use of undeclared variables */
        unused:      true,  /* warns of unused variables */
      },
      all: ['Gruntfile.js', 'lib/**/*.js', 'test/**/*.js']
    },

    nodeunit: 
    {
      all: ['test/nodeunit/**/*.js']
    }
  });

  grunt.loadNpmTasks('grunt-contrib-nodeunit');
  grunt.loadNpmTasks('grunt-contrib-jshint');

  // Default task(s).
  grunt.registerTask('test', ['nodeunit']);
  grunt.registerTask('default', ['test']);

};
