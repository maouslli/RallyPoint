#!/usr/bin/env node
/* Inline demo.html + css + js into one file that runs from disk or an artifact viewer. */
const fs = require('fs');
const path = require('path');
const pub = path.join(__dirname, '..', 'public');
const out = path.join(__dirname, '..', 'dist');
let html = fs.readFileSync(path.join(pub, 'demo.html'), 'utf8');
html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (m, href) => '<style>\n' + fs.readFileSync(path.join(pub, href), 'utf8') + '\n</style>');
html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => '<script>\n' + fs.readFileSync(path.join(pub, src), 'utf8').replace(/<\/script>/gi, '<\\/script>') + '\n</script>');
html = html.replace('<title>RallyPoint — 2-court demonstrator</title>', '<title>RallyPoint — standalone 2-court demonstrator</title>');
fs.mkdirSync(out, { recursive: true });
const file = path.join(out, 'rallypoint-standalone.html');
fs.writeFileSync(file, html);
console.log('Wrote ' + file + ' (' + Math.round(html.length / 1024) + ' kB)');
