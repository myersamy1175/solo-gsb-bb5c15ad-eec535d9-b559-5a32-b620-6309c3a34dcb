/** 在浏览器本地解码音频文件（WAV / MP3 等），音频数据不离开浏览器。 */
export async function decodeAudioFile(file: File, ctx: BaseAudioContext): Promise<AudioBuffer> {
  const bytes = await file.arrayBuffer();
  return await ctx.decodeAudioData(bytes);
}
