
const cluster = require('cluster');
const os = require('os');
const express = require('express');

const numCPUs = os.cpus().length;
const PORT = 3001;

if (cluster.isPrimary) {
  console.log(`Primary ${process.pid} is running`);

  // Fork workers.
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    // console.log(`worker ${worker.process.pid} died`);
  });
} else {
  const app = express();
  app.disable('x-powered-by');

  // Plain Text
  app.get('/', (req, res) => {
    res.send('Hello World');
  });

  // JSON
  app.get('/json', (req, res) => {
    res.json({ hello: 'world' });
  });

  // View (Simulated)
  const viewContent = '<html><body><h1>Hello View</h1></body></html>';
  app.get('/view', (req, res) => {
    res.set('Content-Type', 'text/html');
    res.send(viewContent);
  });

  app.listen(PORT, () => {
    // console.log(`Worker ${process.pid} started on port ${PORT}`);
  });
}
