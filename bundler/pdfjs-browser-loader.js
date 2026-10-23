module.exports = (source) => source.replace(/^const isNodeJS = .*;$/m, 'const isNodeJS = false;');
