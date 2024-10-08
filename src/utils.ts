function snakeCase(input: string): string {
  return input
    .split(/(?=[A-Z])|[\s-_]+/)
    .map(word => word.toLowerCase())
    .join('_');
}

export const blobToBase64 = (blob: Blob): Promise<string | null> => {
  return new Promise((resolve, _) => {
    const reader = new FileReader();
    reader.onloadend = () =>
      resolve(reader.result?.toString().split(",")[1] || null);
    reader.readAsDataURL(blob);
  });
};

export const base64BufferToArrayBuffer = (buffer: Buffer): ArrayBuffer => {
  const base64String = buffer.toString('base64');
  const binaryString = atob(base64String);

  const byteArray = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    byteArray[i] = binaryString.charCodeAt(i);
  }
  return byteArray.buffer;
}

export const stringify = (obj: Object): string => {
  return JSON.stringify(obj, function (key, value) {
    if (value && typeof value === "object") {
      var replacement: { [key: string]: any } = {};
      for (var k in value) {
        if (Object.hasOwnProperty.call(value, k)) {
          replacement[k && snakeCase(k.toString())] = value[k];
        }
      }
      return replacement;
    }
    return value;
  });
};