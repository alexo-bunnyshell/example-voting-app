// Usage: node wait-for.mjs <timeoutSeconds> <url> [url...]
// Waits until every URL answers with a status below 500. Exits 1 on timeout.
const [timeoutArg, ...urls] = process.argv.slice(2);
const deadline = Date.now() + Number(timeoutArg) * 1000;

for (const url of urls) {
  process.stdout.write(`Waiting for ${url} `);
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.status < 500) {
        console.log(`-> ${res.status}`);
        break;
      }
    } catch {
      // not reachable yet
    }
    if (Date.now() > deadline) {
      console.log('-> timed out');
      process.exit(1);
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 3000));
  }
}
