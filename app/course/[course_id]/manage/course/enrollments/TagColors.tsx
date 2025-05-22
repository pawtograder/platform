export class TagColor {
  public static RED = new TagColor("#FF9AA2", "Red");
  public static ORANGE = new TagColor("#FFDAC1", "Orange");
  public static GREEN = new TagColor("#E2F0CB", "Green");
  public static PURPLE = new TagColor("#C7CEEA", "Purple");
  public hex: string;
  public text: string;
  private constructor(hex: string, text: string) {
    this.hex = hex;
    this.text = text;
  }

  public static colors() {
    return [TagColor.RED, TagColor.ORANGE, TagColor.GREEN, TagColor.PURPLE];
  }

  public toString() {
    console.log(this.text);
    return this.text;
  }
}
