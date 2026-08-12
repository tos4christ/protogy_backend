const Service = require('node-windows').Service;
const svc = new Service({
  name: 'Protogy Backend',
  description: 'Protogy IoT API + MQTT ingestion + dashboard',
  script: require('path').join(__dirname, 'server.js'),
});
svc.on('install', () => svc.start());
svc.install();