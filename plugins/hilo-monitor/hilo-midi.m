#import <Foundation/Foundation.h>
#import <CoreMIDI/CoreMIDI.h>
#import <dispatch/dispatch.h>

static const UInt8 manufacturer[] = {0xf0, 0x00, 0x01, 0x54};
static const unsigned monitorRegister = 0x28;
static const int unity = 192;

static BOOL isHiloEndpoint(MIDIEndpointRef endpoint) {
    CFStringRef name = NULL;
    if (MIDIObjectGetStringProperty(endpoint, kMIDIPropertyDisplayName, &name) != noErr) {
        return NO;
    }
    return [CFBridgingRelease(name) isEqualToString:@"Lynx Hilo"];
}

static BOOL findHilo(MIDIEndpointRef *source, MIDIEndpointRef *destination) {
    for (ItemCount index = 0; index < MIDIGetNumberOfSources(); index++) {
        MIDIEndpointRef candidate = MIDIGetSource(index);
        if (!isHiloEndpoint(candidate)) continue;

        MIDIEntityRef entity = 0;
        if (MIDIEndpointGetEntity(candidate, &entity) != noErr || !entity) continue;
        for (ItemCount output = 0; output < MIDIEntityGetNumberOfDestinations(entity); output++) {
            MIDIEndpointRef match = MIDIEntityGetDestination(entity, output);
            if (!isHiloEndpoint(match)) continue;
            if (*source) return NO;
            *source = candidate;
            *destination = match;
        }
    }
    return *source && *destination;
}

static OSStatus sendRegister(MIDIPortRef port, MIDIEndpointRef destination, UInt8 command, UInt8 value) {
    UInt8 data[] = {0xf0, 0x00, 0x01, 0x54,
        (command << 3) | (monitorRegister >> 5),
        ((monitorRegister & 0x1f) << 2) | (value >> 6),
        (value & 0x3f) << 1, 0xf7};
    MIDIPacketList list;
    MIDIPacket *packet = MIDIPacketListInit(&list);
    MIDIPacketListAdd(&list, sizeof(list), packet, 0, sizeof(data), data);
    return MIDISend(port, destination, &list);
}

static int monitorValue(const UInt8 *message, size_t length) {
    // The single-register reply packs eight value bits across two MIDI bytes.
    if (length != 10 || memcmp(message, manufacturer, sizeof(manufacturer)) != 0 ||
        message[4] != (0x70 | (monitorRegister >> 5)) ||
        message[5] != ((monitorRegister & 0x1f) << 2) ||
        message[6] != 0 || message[9] != 0xf7 || (message[8] & 0x3f) != 0) {
        return -1;
    }
    return (message[7] << 1) | (message[8] >> 6);
}

static int requestValue(MIDIPortRef input, MIDIPortRef output, MIDIEndpointRef source, MIDIEndpointRef destination,
    dispatch_semaphore_t response, NSLock *lock, int *level) {
    [lock lock];
    *level = -1;
    [lock unlock];
    if (MIDIPortConnectSource(input, source, NULL) != noErr) return -1;
    int result = -1;
    if (sendRegister(output, destination, 0x0d, 0) == noErr &&
        dispatch_semaphore_wait(response, dispatch_time(DISPATCH_TIME_NOW, 750 * NSEC_PER_MSEC)) == 0) {
        [lock lock];
        result = *level;
        [lock unlock];
    }
    MIDIPortDisconnectSource(input, source);
    return result;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        char *end = NULL;
        long steps = argc == 2 ? strtol(argv[1], &end, 10) : 0;
        if (argc != 2 || end == argv[1] || *end || steps < -10 || steps > 10) {
            fprintf(stderr, "Pass a step count between -10 and 10. Use 0 to read the current level.\n");
            return 1;
        }

        MIDIClientRef client = 0;
        MIDIPortRef input = 0, output = 0;
        MIDIEndpointRef source = 0, destination = 0;
        if (MIDIClientCreate(CFSTR("Hilo Monitor"), NULL, NULL, &client) != noErr ||
            !findHilo(&source, &destination) ||
            MIDIOutputPortCreate(client, CFSTR("Monitor Out"), &output) != noErr) {
            fprintf(stderr, "Connect one Lynx Hilo over USB.\n");
            if (client) MIDIClientDispose(client);
            return 1;
        }

        __block int level = -1;
        __block struct { UInt8 message[10]; size_t length; } parser = {0};
        NSLock *lock = [NSLock new];
        dispatch_semaphore_t response = dispatch_semaphore_create(0);
        OSStatus status = MIDIInputPortCreateWithBlock(client, CFSTR("Monitor Out reply"), &input,
            ^(const MIDIPacketList *list, void *context) {
                const MIDIPacket *packet = &list->packet[0];
                for (UInt32 index = 0; index < list->numPackets; index++) {
                    for (UInt16 byte = 0; byte < packet->length; byte++) {
                        UInt8 value = packet->data[byte];
                        if (value == 0xf0) parser.length = 0;
                        else if (!parser.length) continue;
                        if (parser.length >= sizeof(parser.message)) {
                            parser.length = 0;
                            continue;
                        }
                        parser.message[parser.length++] = value;
                        if (value == 0xf7) {
                            int parsed = monitorValue(parser.message, parser.length);
                            parser.length = 0;
                            if (parsed >= 0) {
                                [lock lock];
                                if (level < 0) {
                                    level = parsed;
                                    dispatch_semaphore_signal(response);
                                }
                                [lock unlock];
                            }
                        }
                    }
                    packet = MIDIPacketNext(packet);
                }
            });
        if (status != noErr) {
            fprintf(stderr, "Cannot open the Hilo MIDI input.\n");
            MIDIClientDispose(client);
            return 1;
        }

        int current = requestValue(input, output, source, destination, response, lock, &level);
        if (current < 0 || current > unity) {
            fprintf(stderr, "Cannot verify the Hilo Monitor Out level.\n");
            MIDIClientDispose(client);
            return 1;
        }
        int target = (int)MIN(unity, MAX(0, current + steps));
        if (target != current && sendRegister(output, destination, 0, (UInt8)target) != noErr) {
            fprintf(stderr, "Cannot adjust the Hilo Monitor Out level.\n");
            MIDIClientDispose(client);
            return 1;
        }
        if (target != current && requestValue(input, output, source, destination, response, lock, &level) != target) {
            fprintf(stderr, "Cannot confirm the new Hilo Monitor Out level.\n");
            MIDIClientDispose(client);
            return 1;
        }
        printf("%.1f\n", (target - unity) * 0.5);
        MIDIClientDispose(client);
        return 0;
    }
}
