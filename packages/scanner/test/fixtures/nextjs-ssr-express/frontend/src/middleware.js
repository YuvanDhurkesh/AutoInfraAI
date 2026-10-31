import { NextResponse } from "next/server";
export function middleware(request) {
  return request.cookies.get("auth_token")
    ? NextResponse.next()
    : NextResponse.redirect(new URL("/login", request.url));
}
