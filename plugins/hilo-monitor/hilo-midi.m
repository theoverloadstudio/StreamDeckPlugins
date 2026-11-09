#import <Foundation/Foundation.h>
#import <CoreMIDI/CoreMIDI.h>
#import <dispatch/dispatch.h>
#include <unistd.h>

static const UInt8 manufacturer[] = {0xf0, 0x00, 0x01, 0x54};
static const unsigned monitorRegister = 0x28;
static const unsigned muteRegister = 0x220;
static const int monitorMuteMask = 0x30; // Monitor Out left and right
static const int unity = 192;
static const int minimumAudible = 49; // -71.5 dB
static const int holdStep = 3; // 1.5 dB
static const int fineRange = 172; // -10 dB
static const int unmuteCeiling = 132; // -30 dB

typedef struct {
    unsigned reg;
    int value;
} RegisterReply;

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

static OSStatus sendRegister(MIDIPortRef port, MIDIEndpointRef destination, unsigned reg, BOOL write, UInt8 value) {
    UInt8 data[11] = {0xf0, 0x00, 0x01, 0x54};
    size_t length;
    if (reg < 256) {
        data[4] = (write ? 0 : 0x68) | (reg >> 5);
        data[5] = ((reg & 0x1f) << 2) | (value >> 6);
        data[6] = (value & 0x3f) << 1;
        length = 8;
    } else {
        data[4] = write ? 0x07 : 0x6f;
        data[5] = reg >> 9;
        data[6] = (reg >> 2) & 0x7f;
        data[7] = ((reg & 3) << 5) | (value >> 3);
        data[8] = (value & 7) << 4;
        length = write ? 10 : 11;
    }
    data[length - 1] = 0xf7;
    MIDIPacketList list;
    MIDIPacket *packet = MIDIPacketListInit(&list);
    MIDIPacketListAdd(&list, sizeof(list), packet, 0, length, data);
    return MIDISend(port, destination, &list);
}

static int registerValue(const UInt8 *message, size_t length, unsigned reg) {
    // The single-register reply packs eight value bits across two MIDI bytes.
    if (length != (reg < 256 ? 10 : 13) || memcmp(message, manufacturer, sizeof(manufacturer)) != 0 ||
        message[length - 1] != 0xf7) return -1;
    if (reg < 256) {
        if (message[4] != (0x70 | (reg >> 5)) || message[5] != ((reg & 0x1f) << 2) ||
            message[6] != 0 || (message[8] & 0x3f) != 0) return -1;
        return (message[7] << 1) | (message[8] >> 6);
    }
    if (message[4] != 0x77 || message[5] != reg >> 9 || message[6] != ((reg >> 2) & 0x7f) ||
        message[7] != ((reg & 3) << 5) || message[8] || message[9] || (message[11] & 0x3f) != 0) return -1;
    return (message[10] << 1) | (message[11] >> 6);
}

static int requestValue(MIDIPortRef input, MIDIPortRef output, MIDIEndpointRef source, MIDIEndpointRef destination,
    unsigned reg, dispatch_semaphore_t response, NSLock *lock, RegisterReply *reply) {
    [lock lock];
    reply->reg = reg;
    reply->value = -1;
    [lock unlock];
    if (MIDIPortConnectSource(input, source, NULL) != noErr) return -1;
    int result = -1;
    if (sendRegister(output, destination, reg, NO, 0) == noErr &&
        dispatch_semaphore_wait(response, dispatch_time(DISPATCH_TIME_NOW, 750 * NSEC_PER_MSEC)) == 0) {
        [lock lock];
        result = reply->value;
        [lock unlock];
    }
    MIDIPortDisconnectSource(input, source);
    return result;
}

static BOOL setValue(MIDIPortRef input, MIDIPortRef output, MIDIEndpointRef source, MIDIEndpointRef destination,
    unsigned reg, int current, int target, dispatch_semaphore_t response, NSLock *lock, RegisterReply *reply) {
    return current == target || (sendRegister(output, destination, reg, YES, (UInt8)target) == noErr &&
        requestValue(input, output, source, destination, reg, response, lock, reply) == target);
}

static BOOL rampGain(MIDIPortRef input, MIDIPortRef output, MIDIEndpointRef source, MIDIEndpointRef destination,
    int current, int target, useconds_t stepDelay, dispatch_semaphore_t response, NSLock *lock, RegisterReply *reply) {
    const int direction = target > current ? 1 : -1;
    while (current != target) {
        const int next = current + direction;

        if (!setValue(input, output, source, destination, monitorRegister, current, next, response, lock, reply)) {
            return NO;
        }
        current = next;
        if (current != target) usleep(current < minimumAudible ? 2500 : stepDelay);
    }
    return YES;
}

static BOOL fadeIn(MIDIPortRef input, MIDIPortRef output, MIDIEndpointRef source, MIDIEndpointRef destination,
    int gain, int targetGain, int muteState, dispatch_semaphore_t response, NSLock *lock, RegisterReply *reply) {
    const int start = 0; // Restore audio with the analog gain at Off.
    const BOOL atStart = (muteState & monitorMuteMask) == monitorMuteMask
        ? setValue(input, output, source, destination, monitorRegister, gain, start, response, lock, reply)
        : rampGain(input, output, source, destination, gain, start, 6500, response, lock, reply);
    return atStart &&
        setValue(input, output, source, destination, muteRegister, muteState, muteState & ~monitorMuteMask, response, lock, reply) &&
        rampGain(input, output, source, destination, start, targetGain, 7500, response, lock, reply);
}

static int raisedTarget(int current, int steps) {
    return current >= fineRange ? MIN(unity, current + 1) : MIN(fineRange, current + steps);
}

static int buttonTarget(int current, BOOL up, BOOL repeat) {
    if (up && current < minimumAudible) return minimumAudible;
    if (!up && current <= minimumAudible) return 0;
    if (repeat) {
        if (up) return raisedTarget(current, holdStep);
        return current > fineRange ? current - 1 : MAX(minimumAudible, current - holdStep);
    }
    const int boundaries[] = {minimumAudible, 132, 152, 172, unity};
    const int steps[] = {12, 5, 2, 1};
    if (up) {
        for (int i = 0; i < 4; i++) {
            if (current < boundaries[i + 1]) return MIN(boundaries[i + 1], current + steps[i]);
        }
    } else {
        for (int i = 3; i >= 0; i--) {
            if (current > boundaries[i]) return MAX(boundaries[i], current - steps[i]);
        }
    }
    return current;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        char *end = NULL;
        NSString *action = argc == 2 ? @(argv[1]) : @"";
        BOOL mute = [action isEqualToString:@"mute"];
        BOOL readMute = [action isEqualToString:@"read-mute"];
        BOOL up = [action isEqualToString:@"up"] || [action isEqualToString:@"hold-up"];
        BOOL down = [action isEqualToString:@"down"] || [action isEqualToString:@"hold-down"];
        BOOL repeat = [action hasPrefix:@"hold-"];
        long steps = action.length ? strtol(argv[1], &end, 10) : 0;
        if (!(mute || readMute || up || down) && (!end || end == argv[1] || *end || steps < -10 || steps > 10)) {
            fprintf(stderr, "Pass up, down, hold-up, hold-down, mute, read-mute, or a step count between -10 and 10.\n");
            return 1;
        }
        unsigned reg = mute || readMute ? muteRegister : monitorRegister;

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

        __block RegisterReply reply = {0};
        __block struct { UInt8 message[13]; size_t length; } parser = {0};
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
                            [lock lock];
                            int parsed = registerValue(parser.message, parser.length, reply.reg);
                            if (parsed >= 0 && reply.value < 0) {
                                reply.value = parsed;
                                dispatch_semaphore_signal(response);
                            }
                            [lock unlock];
                            parser.length = 0;
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

        int current = requestValue(input, output, source, destination, reg, response, lock, &reply);
        if (current < 0 || (reg == monitorRegister && current > unity)) {
            fprintf(stderr, "Cannot verify the Hilo Monitor Out state.\n");
            MIDIClientDispose(client);
            return 1;
        }
        int target = current;
        BOOL verified;
        if (mute) {
            target = (current & monitorMuteMask) == monitorMuteMask
                ? current & ~monitorMuteMask : current | monitorMuteMask;
            if (!(target & monitorMuteMask)) {
                int gain = requestValue(input, output, source, destination, monitorRegister, response, lock, &reply);
                verified = gain >= 0 && gain <= unity &&
                    fadeIn(input, output, source, destination, gain, MIN(gain, unmuteCeiling), current, response, lock, &reply);
            } else {
                verified = setValue(input, output, source, destination, reg, current, target, response, lock, &reply);
            }
        } else if (readMute) {
            verified = YES;
        } else {
            if (up || down) target = buttonTarget(current, up, repeat);
            else if (steps > 0) target = raisedTarget(current, (int)steps);
            else if (steps < 0) target = (int)MAX(0, current + steps);

            int muteState = up && !repeat
                ? requestValue(input, output, source, destination, muteRegister, response, lock, &reply) : 0;
            if (muteState < 0) {
                fprintf(stderr, "Cannot read the Hilo Monitor Out mute state.\n");
                MIDIClientDispose(client);
                return 1;
            }
            if (muteState & monitorMuteMask) {
                target = MIN(target, unmuteCeiling);
                verified = fadeIn(input, output, source, destination, current, target, muteState, response, lock, &reply);
            } else {
                verified = rampGain(input, output, source, destination, current, target, repeat ? 6500 : 10000,
                    response, lock, &reply);
            }
        }

        if (!verified) {
            fprintf(stderr, "Cannot confirm the new Hilo Monitor Out state.\n");
            MIDIClientDispose(client);
            return 1;
        }
        if (reg == muteRegister) puts((target & monitorMuteMask) == monitorMuteMask ? "Muted" : "Unmuted");
        else if (repeat && (target == current || (up && target == unity) || (down && !target))) puts("Limit");
        else if (target == 0) puts("Off");
        else printf("%.1f\n", (target - unity) * 0.5);
        MIDIClientDispose(client);
        return 0;
    }
}
