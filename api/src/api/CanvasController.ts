import { CanvasApi } from "@kth/canvas-api";
import * as dotenv from "dotenv";
import { Course, Enrollment, User, UserProfile } from "../CanvasTypes.js";
import { Get, Route, Security } from "tsoa";

dotenv.config();
const CANVAS_API_KEY = process.env.CANVAS_API_KEY || "";

@Route('/api/admin/canvas')
@Security('supabase', ['admin'])
export class CanvasController {
  private canvas: CanvasApi;
  constructor() {
    this.canvas = new CanvasApi('https://northeastern.instructure.com/api/v1', CANVAS_API_KEY);
  }

  @Get('/courses')
  async getCanvasCourses() : Promise<Course[]>{
    const pages = await this.canvas.listPages("courses/");
    const ret = [];
    for await (const page of pages) {
      ret.push(...page.json);
    }
    return ret;
  }

  @Get('/courses/{courseId}')
  async getCanvasCourse(courseId: number) : Promise<Course>{
    const { json } = await this.canvas.get(`courses/${courseId}`);
    return json;
  }

  async getEnrollments(courseId: number): Promise<Enrollment[]> {
    const pages = await this.canvas.listPages(`courses/${courseId}/enrollments`);
    const ret = [];
    for await (const page of pages) {
      ret.push(...page.json);
    }
    return ret;
  }

  async getUser(userId: number): Promise<UserProfile> {
    const { json } = await this.canvas.get(`users/${userId}/profile`);
    return json;
  }

}