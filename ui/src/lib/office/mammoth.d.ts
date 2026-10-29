/** The part of the mammoth API the docx viewer uses. mammoth ships no type declarations. */
declare module 'mammoth' {
  interface MammothImage { contentType: string; altText?: string; read(encoding: 'base64'): Promise<string> }
  interface ImageConverter { readonly __mammothImageConverter: true }
  interface ConvertOptions {
    convertImage?: ImageConverter;
    ignoreEmptyParagraphs?: boolean;
    includeDefaultStyleMap?: boolean;
    styleMap?: string | string[];
  }
  interface ConvertResult { value: string; messages: { type: string; message: string }[] }
  const mammoth: {
    convertToHtml(input: { arrayBuffer: ArrayBuffer; buffer?: ArrayBuffer }, options?: ConvertOptions): Promise<ConvertResult>;
    images: { imgElement(convert: (image: MammothImage) => Promise<{ src: string; alt?: string }>): ImageConverter };
  };
  export default mammoth;
}
