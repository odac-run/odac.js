
const { spawn } = require('child_process');
const autocannon = require('autocannon');
const fs = require('fs');
const path = require('path');

const servers = [
  { name: 'ODAC', script: 'odac_bench.js', port: 3000 },
  { name: 'Express', script: 'express_bench.js', port: 3001 },
  { name: 'Fastify', script: 'fastify_bench.js', port: 3002 }
];

const endpoints = [
  { path: '/', label: 'Plain Text' },
  { path: '/json', label: 'JSON API' },
  { path: '/view', label: 'View Rendering' }
];

const results = {};

async function runAutocannon(url) {
  return new Promise((resolve, reject) => {
    autocannon({
      url,
      connections: 100,
      duration: 10,
      pipelining: 1,
    }, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

async function runServerBenchmark(serverConfig) {
  console.log(`Starting ${serverConfig.name}...`);
  const serverProcess = spawn('node', [serverConfig.script], {
    cwd: __dirname,
    stdio: 'ignore', // 'inherit' for debugging
    env: { ...process.env, NODE_ENV: 'production', PORT: serverConfig.port }
  });

  // Give it time to start
  await new Promise(resolve => setTimeout(resolve, 3000));

  results[serverConfig.name] = {};

  for (const endpoint of endpoints) {
    console.log(`Benchmarking ${serverConfig.name} - ${endpoint.label}...`);
    try {
      const result = await runAutocannon(`http://localhost:${serverConfig.port}${endpoint.path}`);
      results[serverConfig.name][endpoint.label] = {
        rps: result.requests.average, // requests per second
        latency: result.latency.average // latency in ms
      };
      console.log(`Result: ${result.requests.average} RPS, ${result.latency.average} ms`);
    } catch (err) {
      console.error(`Error benchmarking ${endpoint.label}:`, err);
      results[serverConfig.name][endpoint.label] = { rps: 0, latency: 0 };
    }
  }

  console.log(`Stopping ${serverConfig.name}...`);
  serverProcess.kill('SIGTERM');

  // Wait for cleanup
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Force kill if still running
  try { serverProcess.kill('SIGKILL'); } catch (e) {}
}

async function generateReport() {
  let report = `# ODAC.JS vs Express vs Fastify Benchmark Raporu\n\n`;
  report += `Bu rapor, ODAC.JS framework'ünün performansını Express ve Fastify ile karşılaştırmak için hazırlanmıştır.\n`;
  report += `Testler **${require('os').cpus().length} vCPU** üzerinde, **Node.js Cluster** modülü aktif edilerek yapılmıştır.\n\n`;

  report += `## Metodoloji\n`;
  report += `- **Araç:** Autocannon (100 bağlantı, 10 saniye)\n`;
  report += `- **Ortam:** Node.js ${process.version}, Production Mode\n`;
  report += `- **Senaryolar:**\n`;
  report += `  - **Plain Text:** Basit "Hello World" yanıtı.\n`;
  report += `  - **JSON:** Basit JSON objesi yanıtı.\n`;
  report += `  - **View:** HTML Rendering (ODAC için template engine, diğerleri için statik HTML simülasyonu).\n\n`;

  report += `## Sonuçlar\n\n`;

  // Table per endpoint type? Or summary table?
  // Let's do a table per endpoint type.

  for (const endpoint of endpoints) {
    report += `### ${endpoint.label}\n`;
    report += `| Framework | Requests/Sec (RPS) | Latency (ms) |\n`;
    report += `|-----------|--------------------|--------------|\n`;

    // Sort by RPS descending
    const sorted = servers.sort((a, b) => {
        const rpsA = results[a.name][endpoint.label]?.rps || 0;
        const rpsB = results[b.name][endpoint.label]?.rps || 0;
        return rpsB - rpsA;
    });

    for (const server of sorted) {
      const data = results[server.name][endpoint.label];
      report += `| **${server.name}** | ${data.rps.toFixed(2)} | ${data.latency.toFixed(2)} |\n`;
    }
    report += `\n`;
  }

  report += `## Değerlendirme\n\n`;
  report += `(Bu bölüm benchmark sonuçlarına göre otomatik oluşturulmuştur)\n\n`;

  // Simple analysis
  const odacRps = results['ODAC']['JSON API']?.rps || 0;
  const expressRps = results['Express']['JSON API']?.rps || 0;
  const fastifyRps = results['Fastify']['JSON API']?.rps || 0;

  if (odacRps > expressRps) {
    report += `- ODAC.JS, JSON testlerinde Express'ten daha yüksek performans göstermiştir.\n`;
  } else {
    report += `- ODAC.JS, JSON testlerinde Express'in gerisinde kalmıştır.\n`;
  }

   if (odacRps > fastifyRps) {
    report += `- ODAC.JS, JSON testlerinde Fastify'dan daha yüksek performans göstermiştir.\n`;
  }

  fs.writeFileSync('BENCHMARK_RESULTS.md', report);
  console.log('Rapor oluşturuldu: BENCHMARK_RESULTS.md');
}

(async () => {
  for (const server of servers) {
    await runServerBenchmark(server);
  }
  await generateReport();
})();
