// The MAIL surface end-to-end: an email question -> he replies via the (mocked) mail
// CLI. Validates the absolute-path mail grant is doctored to a mockable friendly one.
import { calledTool, delivered, succeeded } from "../assertions.mjs";
export default {
  name: "mail: replies to a simple email via the mail CLI",
  surface: "mail",
  slots: {
    FROM: "Erik <erik@example.com>",
    SUBJECT: "quick question",
    BODY: "Hi Baxter — what's a good, simple weeknight pasta? One line is fine. Thanks!",
    MESSAGE_ID: "<q1@example.com>",
  },
  expect: [
    calledTool("mail", "reply"),  // replied in-thread via mail
    delivered(),
    succeeded(),
  ],
};
