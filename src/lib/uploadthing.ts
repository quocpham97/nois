"use client";

import { generateReactHelpers } from "@uploadthing/react";
import type { OurFileRouter } from "@/app/api/uploadthing/core";

// Typed client helpers for the message-attachment file router. `useUploadThing`
// gives startUpload + isUploading + progress; the OurFileRouter type import is
// erased at build time so no server code is pulled into the client bundle.
export const { useUploadThing, uploadFiles } =
  generateReactHelpers<OurFileRouter>();
