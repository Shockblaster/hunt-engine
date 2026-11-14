import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// In LAN mode (`he dashboard lan`) every request needs the key from the link the CLI prints, so other people on the
// same Wi-Fi cannot see the data or press Approve. Local-only mode binds to 127.0.0.1 and needs no key.
export function proxy(request: NextRequest) {
  const key = process.env.HE_LAN_KEY;
  if (!key) return NextResponse.next();
  const given = request.nextUrl.searchParams.get("key");
  if (given === key) {
    const url = request.nextUrl.clone();
    url.searchParams.delete("key");
    const res = NextResponse.redirect(url);
    res.cookies.set("he_lan", key, { httpOnly: true, sameSite: "strict", path: "/", maxAge: 60 * 60 * 24 * 30 });
    return res;
  }
  if (request.cookies.get("he_lan")?.value === key) return NextResponse.next();
  return new NextResponse("Open the link printed by `he dashboard lan` to view this dashboard.", { status: 403 });
}

export const config = { matcher: "/((?!_next/static|_next/image|favicon.ico).*)" };
