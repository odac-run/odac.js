
const cluster = require('cluster');
const os = require('os');
const fastify = require('fastify')({ logger: false });

const numCPUs = os.cpus().length;
const PORT = 3002;

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
  // Plain Text
  fastify.get('/', async (request, reply) => {
    return 'Hello World';
  });

  // JSON
  fastify.get('/json', async (request, reply) => {
    return { hello: 'world' };
  });

  // View (Simulated)
  const viewContent = '<html><body><h1>Hello View</h1></body></html>';
  fastify.get('/view', async (request, reply) => {
    reply.type('text/html').send(viewContent);
  });

  fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    // console.log(`Worker ${process.pid} listening on ${address}`);
  });
}
