import { signOutAction } from "@/app/actions";
import { redirect } from "next/navigation";
export default function SignOut() {
  signOutAction();
  redirect("/");
}
