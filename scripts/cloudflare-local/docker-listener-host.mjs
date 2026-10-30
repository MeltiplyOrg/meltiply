import { createSocket } from "node:dgram";

// Select the local IPv4 source on the route to Docker's bridge gateway without
// sending a packet. Both native hosts and DinD own this bridge interface.
// The result is the shared listen/signing host reachable by processor containers.
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
