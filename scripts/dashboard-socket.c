#include <fcntl.h>
#include <launch.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
    int *sockets = NULL;
    size_t count = 0;
    if (argc < 2 || launch_activate_socket("Dashboard", &sockets, &count) != 0 || count != 1) {
        fputs("Could not obtain the Dashboard socket from launchd.\n", stderr);
        free(sockets);
        return 1;
    }

    int socket = sockets[0];
    free(sockets);
    // Node adopts descriptor 3 through server.listen({ fd: 3 }).
    if (dup2(socket, 3) < 0 || fcntl(3, F_SETFD, 0) < 0) {
        perror("Could not pass the Dashboard socket to Node");
        return 1;
    }
    if (socket != 3) close(socket);
    execv(argv[1], &argv[1]);
    perror("Could not start the Dashboard");
    return 1;
}
