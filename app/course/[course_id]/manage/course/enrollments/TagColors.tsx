export class TagColor {
  public static RED = new TagColor("red");
  public static ORANGE = new TagColor("orange");
  public static YELLOW = new TagColor("yellow");
  public static GREEN = new TagColor("green");
  public static BLUE = new TagColor("blue");
  public static CYAN = new TagColor("cyan");

  public static PURPLE = new TagColor("purple");
  public static GRAY = new TagColor("gray");

  public value: string;
  private constructor(value: string) {
    this.value = value;
  }

  public static colors() {
    return [
      TagColor.RED,
      TagColor.ORANGE,
      TagColor.YELLOW,
      TagColor.GREEN,
      TagColor.BLUE,
      TagColor.CYAN,
      TagColor.PURPLE,
      TagColor.GRAY
    ];
  }

  public toString() {
    return this.value;
  }
}
