import { db } from "../../../../src/db/client";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  return Response.json(await db.user.findUnique({ where: { id: params.id } }));
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  await db.user.delete({ where: { id: params.id } });
  return new Response(null, { status: 204 });
}
