async computeObjectSha256(bucket, key) {
  const hash = createHash5("sha256");
  const metadata = await this.client.send(new HeadObjectCommand({Bucket: bucket, Key: key}));
  const size = metadata.ContentLength;
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid object size for SHA256");
  const rangeBytes = 64 * 1024 * 1024;
  for (let start = 0; start < size; start += rangeBytes) {
    const end = Math.min(size - 1, start + rangeBytes - 1);
    const ranged = size > rangeBytes;
    const out = await this.client.send(new GetObjectCommand2({
      Bucket: bucket, Key: key,
      ...(metadata.ETag ? {IfMatch: metadata.ETag} : {}),
      ...(ranged ? {Range: `bytes=${start}-${end}`} : {})
    }));
    const body = extractStreamFromGet(out);
    try {
      if (ranged && out.ContentRange !== `bytes ${start}-${end}/${size}`) throw new Error("Unexpected object range for SHA256");
      let received = 0;
      for await (const chunk of body) {
        received += chunk.length;
        if (received > end - start + 1) throw new Error("Object range exceeds expected size");
        hash.update(chunk);
      }
      if (received !== end - start + 1) throw new Error("Truncated object range for SHA256");
    } catch (error) { body.destroy(); throw error; }
  }
  return hash.digest("hex");
}
