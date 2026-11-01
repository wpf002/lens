import { defineRailway, project, service } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "lens";
export default defineRailway(() => {
  const lens = service("lens", {
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/",
    healthcheckTimeout: 120,
    replicas: { "us-west2": 1 },
  });

  return project("lens", {
    variables: { managed: false },
    resources: [lens],
  });
});
