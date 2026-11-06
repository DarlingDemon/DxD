async copyLargeObjectForPublication({sourceBucket, sourceKey, destinationBucket, destinationKey, newContentType}, source) {
  const partSize = Math.max(64 * 1024 * 1024, Math.ceil(source.ContentLength / 10000 / 1048576) * 1048576);
  const partCount = Math.ceil(source.ContentLength / partSize);
  const tags = await this.client.send(new GetObjectTaggingCommand({Bucket: sourceBucket, Key: sourceKey}));
  const tagString = new URLSearchParams((tags.TagSet ?? []).map(t => [t.Key, t.Value])).toString();
  const created = await this.client.send(new CreateMultipartUploadCommand({Bucket: destinationBucket, Key: destinationKey, ContentType: newContentType, ...(tagString ? {Tagging: tagString} : {})}));
  if (!created.UploadId) throw new Error("Missing multipart copy upload ID");
  const target = {Bucket: destinationBucket, Key: destinationKey, UploadId: created.UploadId};
  let completed = false, next = 0, failed = false;
  try {
    const parts = new Array(partCount);
    const results = await Promise.allSettled(Array.from({length: Math.min(4, partCount)}, async () => {
      while (!failed) {
        const index = next++;
        if (index >= partCount) return;
        try {
          const start = index * partSize, end = Math.min(source.ContentLength - 1, start + partSize - 1);
          const result = await this.client.send(new UploadPartCopyCommand({...target, PartNumber: index + 1,
            CopySource: this.copySource(sourceBucket, sourceKey), CopySourceRange: `bytes=${start}-${end}`,
            ...(source.ETag ? {CopySourceIfMatch: source.ETag} : {})}));
          if (!result.CopyPartResult?.ETag) throw new Error("Missing multipart copy ETag");
          parts[index] = {PartNumber: index + 1, ETag: result.CopyPartResult.ETag};
        } catch (error) { failed = true; throw error; }
      }
    }));
    const failure = results.find(r => r.status === "rejected");
    if (failure) throw failure.reason;
    await this.client.send(new CompleteMultipartUploadCommand({...target, MultipartUpload: {Parts: parts}}));
    completed = true;
  } finally {
    if (!completed) await this.client.send(new AbortMultipartUploadCommand(target)).catch(error => {
      Logger.warn({error}, "Failed to abort temporary multipart publication copy");
    });
  }
}
