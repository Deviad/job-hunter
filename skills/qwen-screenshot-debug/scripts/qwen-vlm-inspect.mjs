#!/usr/bin/env node
// Inspect an image with the local Qwen VLM via LM Studio without using a shell pipeline.
// Usage:
//   node ../../qwen-screenshot-debug/scripts/qwen-vlm-inspect.mjs /tmp/screenshot.png "Inspect this browser screenshot..."
import fs from 'node:fs';

const imagePath = process.argv[2];
const prompt = process.argv.slice(3).join(' ') || 'Inspect this browser screenshot. Answer with visible status, any error text, whether the expected action appears complete, and the next visible button/control to click.';
const endpoint = process.env.QWEN_VLM_ENDPOINT || 'http://localhost:1234/v1/chat/completions';
const model = process.env.QWEN_VLM_MODEL || 'qwen3.6-35b-a3b-holo3-qwopus-instruct-qx64-hi-mlx';

if (!imagePath) {
  console.error('Usage: qwen-vlm-inspect.mjs <image-path> [prompt]');
  process.exit(2);
}

const b64 = fs.readFileSync(imagePath).toString('base64');
const body = {
  model,
  messages: [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
      { type: 'text', text: prompt },
    ],
  }],
  max_tokens: Number(process.env.QWEN_VLM_MAX_TOKENS || 300),
  temperature: Number(process.env.QWEN_VLM_TEMPERATURE || 0.1),
};

const res = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const text = await res.text();
if (!res.ok) {
  console.error(`Qwen VLM HTTP ${res.status}: ${text.slice(0, 1000)}`);
  process.exit(1);
}

let data;
try { data = JSON.parse(text); }
catch (err) {
  console.error(`Invalid JSON from Qwen VLM: ${text.slice(0, 1000)}`);
  process.exit(1);
}

const answer = data?.choices?.[0]?.message?.content;
if (!answer) {
  console.error(`No Qwen answer in response: ${JSON.stringify(data).slice(0, 1000)}`);
  process.exit(1);
}
console.log(answer.trim());
