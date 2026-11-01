export async function POST(req: Request) {
  const event = await req.json();
  console.log(event.type);
  return new Response("ok");
}
