declare module "qrcode-terminal" {
  function generate(
    text: string,
    options: { small?: boolean },
    callback: (qr: string) => void,
  ): void;
  export default { generate };
}
