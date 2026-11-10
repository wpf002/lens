export function Profile({ bio }: { bio: string }) {
  return <div dangerouslySetInnerHTML={{ __html: bio }} />;
}

export function NavScript() {
  return <script dangerouslySetInnerHTML={{ __html: "document.documentElement.dataset.nav='rail'" }} />;
}
