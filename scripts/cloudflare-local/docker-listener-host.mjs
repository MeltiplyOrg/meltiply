import { createSocket } from "node:dgram";

// A connected UDP socket reveals the local source address for Docker's bridge
// gateway without sending a packet.
const socket = createSocket("udp4");
try {
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.connect(9, process.argv[2], resolve);
  });
  process.stdout.write(socket.address().address);
} finally {
  socket.close();
}
