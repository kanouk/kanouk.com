// Receives URLs selected from explicitly identified published articles only.
import { getLinkPreview, isOwnLinkPreviewHost, linkPreviewCacheOptionName } from '../plugins/yohaku-content-blocks/src/link-preview.ts';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const results = [];
for (const url of [...new Set(JSON.parse(input))]) {
  try {
    const target = new URL(url);
    if (isOwnLinkPreviewHost(target.hostname)) continue;
    let value;
    await getLinkPreview(url, { get: async () => null, set: async (_, record) => { value = record; } });
    if (value) results.push({ url, name: await linkPreviewCacheOptionName(url), value });
  } catch (error) { results.push({ url, error: error.code || 'FETCH_FAILED' }); }
}
console.log(JSON.stringify(results));
