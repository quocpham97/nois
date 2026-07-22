import { createUploadthing, type FileRouter } from "uploadthing/next";
import { UploadThingError } from "uploadthing/server";
import { auth } from "@/auth";

const f = createUploadthing();

// File router for chat message attachments. Uploads go browser → UploadThing
// storage directly (presigned); this server only authenticates the request and
// receives the completion callback. Images are stored in plaintext (see the
// attachment plan) — the resulting CDN URL rides alongside the message.
export const ourFileRouter = {
  messageAttachment: f({
    image: { maxFileSize: "8MB", maxFileCount: 1 },
    blob: { maxFileSize: "16MB", maxFileCount: 1 },
  })
    // Only authenticated users may upload. The Auth.js session is verified here;
    // the resolved uid is attached to the upload for the completion callback.
    .middleware(async () => {
      const session = await auth();
      const userId = (session?.user as { id?: string } | undefined)?.id;
      if (!userId) throw new UploadThingError("Unauthorized");
      return { userId };
    })
    // Runs on UploadThing's servers after the file lands. The returned object is
    // echoed back to the client's onClientUploadComplete.
    .onUploadComplete(async ({ metadata, file }) => ({
      uploadedBy: metadata.userId,
      url: file.ufsUrl,
      key: file.key,
      name: file.name,
      size: file.size,
      type: file.type,
    })),
} satisfies FileRouter;

export type OurFileRouter = typeof ourFileRouter;
