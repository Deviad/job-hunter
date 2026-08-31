#!/usr/bin/env python3
import select
import socket
import threading

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 9222
TARGET_HOST = "127.0.0.1"
TARGET_PORT = 9223
BUFFER_SIZE = 65536


def pipe(client):
    target = socket.create_connection((TARGET_HOST, TARGET_PORT))
    sockets = [client, target]
    try:
        while True:
            readable, _, _ = select.select(sockets, [], [])
            for source in readable:
                data = source.recv(BUFFER_SIZE)
                if not data:
                    return
                destination = target if source is client else client
                destination.sendall(data)
    finally:
        client.close()
        target.close()


def main():
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((LISTEN_HOST, LISTEN_PORT))
    listener.listen(50)
    while True:
        client, _ = listener.accept()
        threading.Thread(target=pipe, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
