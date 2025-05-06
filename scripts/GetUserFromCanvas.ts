import dotenv from "dotenv";
import Canvas, { CanvasApi } from "@kth/canvas-api";

dotenv.config({ path: "./supabase/functions/.env" });

const canvas = new CanvasApi(process.env.CANVAS_API_URL!, process.env.CANVAS_API_KEY!);
async function main() {
  // const userId = 111522; //356802;
  // const userId = 356802;
  const userId = 322746;
  const { json } = await canvas.get(`users/${userId}/profile`);
  console.log(json);
}
main();
