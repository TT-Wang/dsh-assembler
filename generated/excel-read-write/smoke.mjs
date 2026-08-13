// Smoke test for the excel-read-write MCP stdio server.
// 1) listTools()  -> verify the 4 tools are registered
// 2) real round-trips: write-xlsx-file -> read-xlsx-file (cell write + read-back),
//    write-csv-file -> read-csv-file, plus a formula cell
// 3) missing-argument call -> expect a validation error result
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-smoke-'));
const xlsxPath = path.join(tmpDir, 'sample.xlsx');
const csvPath = path.join(tmpDir, 'sample.csv');

const transport = new StdioClientTransport({
  command: 'node',
  args: ['index.js'],
});
const client = new Client({ name: 'smoke', version: '0.0.1' });

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function callTool(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  return { res, text };
}

try {
  await client.connect(transport);

  console.log('== 1. listTools ==');
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  console.log('  tools:', names.join(', '));
  check('4 tools registered', names.length === 4, JSON.stringify(names));
  for (const want of ['read-xlsx-file', 'write-xlsx-file', 'read-csv-file', 'write-csv-file']) {
    check(`has tool ${want}`, names.includes(want));
    const t = tools.tools.find((x) => x.name === want);
    check(`tool ${want} has description`, !!t.description && t.description.length > 20);
  }

  console.log('== 2. write-xlsx-file -> read-xlsx-file round trip ==');
  const writeRes = await callTool('write-xlsx-file', {
    filePath: xlsxPath,
    sheets: [
      {
        name: 'Sales',
        rows: [
          ['Product', 'Qty', 'Price', 'Note'],
          ['Apple', 3, 1.5, 'fruit'],
          ['Banana', 5, 0.4, null],
          ['Total', '=SUM(B2:B3)', null, null],
        ],
      },
      {
        name: 'Empty',
        rows: [],
      },
    ],
  });
  const writeOut = JSON.parse(writeRes.text);
  check('write-xlsx-file returns 2 sheets', writeOut.sheets.length === 2, writeOut.sheets?.length);
  check('write-xlsx-file file exists', fs.existsSync(xlsxPath));
  check('Sales rowCount=4', writeOut.sheets[0].rowCount === 4, writeOut.sheets[0]?.rowCount);

  const readRes = await callTool('read-xlsx-file', { filePath: xlsxPath, sheetName: 'Sales' });
  const readOut = JSON.parse(readRes.text);
  check('read-xlsx-file lists sheet names', Array.isArray(readOut.sheetNames) && readOut.sheetNames.includes('Sales'));
  const sheet = readOut.sheets[0];
  check('read-back cell B2 == 3', sheet.data[1][1] === 3, JSON.stringify(sheet.data[1]?.[1]));
  check('read-back cell C2 == 1.5', sheet.data[1][2] === 1.5, JSON.stringify(sheet.data[1]?.[2]));
  check('read-back empty cell D3 is null', sheet.data[2][3] === null, JSON.stringify(sheet.data[2]?.[3]));
  check('read-back formula cell B4', String(sheet.data[3][1]).startsWith('=') || sheet.data[3][1] === 8, JSON.stringify(sheet.data[3]?.[1]));

  console.log('== 2b. read-xlsx-file with cellRange ==');
  const rangeRes = await callTool('read-xlsx-file', { filePath: xlsxPath, sheetName: 'Sales', cellRange: 'A1:B2' });
  const rangeOut = JSON.parse(rangeRes.text);
  check('cellRange A1:B2 gives 2x2 data', rangeOut.sheets[0].data.length === 2 && rangeOut.sheets[0].data[0].length === 2, JSON.stringify(rangeOut.sheets[0].data));

  console.log('== 2c. read-xlsx-file nonexistent sheet ==');
  const badSheetRes = await callTool('read-xlsx-file', { filePath: xlsxPath, sheetName: 'Nope' });
  check('unknown sheet -> ERROR text', badSheetRes.text.startsWith('ERROR:'), badSheetRes.text.slice(0, 80));

  console.log('== 3. write-csv-file -> read-csv-file round trip ==');
  const csvWriteRes = await callTool('write-csv-file', {
    filePath: csvPath,
    rows: [
      ['name', 'age', 'city'],
      ['Ada', 36, 'London'],
      ['Bob', 42, null],
    ],
  });
  check('write-csv-file ok', JSON.parse(csvWriteRes.text).rowCount === 3);
  const csvReadRes = await callTool('read-csv-file', { filePath: csvPath });
  const csvOut = JSON.parse(csvReadRes.text);
  check('csv read-back header', csvOut.data[0][0] === 'name', JSON.stringify(csvOut.data[0]));
  check('csv read-back numeric age', csvOut.data[1][1] === 36, JSON.stringify(csvOut.data[1]?.[1]));
  check('csv read-back empty field null', csvOut.data[2][2] === null, JSON.stringify(csvOut.data[2]?.[2]));

  console.log('== 4. missing-argument validation ==');
  const missingRes = await callTool('read-xlsx-file', {});
  const missingErr = missingRes.res.isError === true || missingRes.text.startsWith('ERROR:');
  check('missing filePath -> validation error', missingErr, JSON.stringify({ isError: missingRes.res.isError, text: missingRes.text.slice(0, 100) }));
  const missingCsv = await callTool('write-csv-file', { filePath: path.join(tmpDir, 'x.csv') });
  const missingCsvErr = missingCsv.res.isError === true || missingCsv.text.startsWith('ERROR:');
  check('missing rows -> validation error', missingCsvErr, JSON.stringify({ isError: missingCsv.res.isError, text: missingCsv.text.slice(0, 100) }));

  console.log('== 5. nonexistent input file -> clean ERROR ==');
  const noFile = await callTool('read-xlsx-file', { filePath: path.join(tmpDir, 'nope.xlsx') });
  check('missing file -> ERROR text', noFile.text.startsWith('ERROR:'), noFile.text.slice(0, 80));

  console.log('== 6. invalid cellRange -> clean ERROR ==');
  const badRange = await callTool('read-xlsx-file', { filePath: xlsxPath, cellRange: 'BOGUS' });
  check('invalid cellRange -> ERROR text', badRange.text.startsWith('ERROR:'), badRange.text.slice(0, 80));
} catch (err) {
  failures += 1;
  console.error('SMOKE CRASH:', err);
} finally {
  try { await client.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? '\nSMOKE RESULT: ALL PASS' : `\nSMOKE RESULT: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
