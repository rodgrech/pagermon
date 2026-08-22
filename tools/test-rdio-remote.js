const config = require('/config/config.json');
const radio = config.integrations.radio;
const headers = {Authorization: `Bearer ${radio.remoteToken}`};
(async () => {
  const callsResponse = await fetch(`${radio.remoteUrl}/calls?limit=2`, {headers});
  if (!callsResponse.ok) throw new Error(`calls HTTP ${callsResponse.status}`);
  const payload = await callsResponse.json();
  if (!payload.calls || !payload.calls.length) throw new Error('No calls returned');
  const call = payload.calls[0];
  const audioResponse = await fetch(`${radio.remoteUrl}/calls/${call.id}/audio`, {headers: {...headers, Range: 'bytes=0-1023'}});
  if (![200, 206].includes(audioResponse.status)) throw new Error(`audio HTTP ${audioResponse.status}`);
  const audio = await audioResponse.arrayBuffer();
  console.log(JSON.stringify({calls: payload.calls.length, latestCallId: call.id, system: call.systemLabel, talkgroup: call.talkgroupLabel, audioStatus: audioResponse.status, audioBytes: audio.byteLength}));
})().catch(error => { console.error(error.message); process.exit(1); });
