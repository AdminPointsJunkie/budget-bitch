import { execFileSync } from "node:child_process";
import { join } from "node:path";

export default async function afterPack(context) {
  if (context.electronPlatformName!=="darwin") return;
  const appName=`${context.packager.appInfo.productFilename}.app`;
  const appPath=join(context.appOutDir,appName);
  execFileSync("/usr/bin/codesign",["--force","--deep","--sign","-",appPath],{stdio:"inherit"});
}
