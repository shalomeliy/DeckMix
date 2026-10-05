// The package ships no types; `keylock.ts` narrows the node it returns to what this app uses.
declare module 'signalsmith-stretch' {
  const SignalsmithStretch: (ctx: BaseAudioContext, options?: AudioWorkletNodeOptions) => Promise<AudioNode>
  export default SignalsmithStretch
}
