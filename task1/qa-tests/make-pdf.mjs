// Renders ../report.html to ../Task1_QA_Report_NamanMalhotra.pdf with the local Chrome
import { chromium } from 'playwright-core';
import { fileURLToPath, pathToFileURL } from 'node:url';
const html = fileURLToPath(new URL('../report.html', import.meta.url));
const pdf = fileURLToPath(new URL('../Task1_QA_Report_NamanMalhotra.pdf', import.meta.url));
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await b.newPage();
await p.goto(pathToFileURL(html).href, { waitUntil: 'load' });
await p.pdf({ path: pdf, format: 'A4', printBackground: true, preferCSSPageSize: true });
await b.close();
console.log('written', pdf);
