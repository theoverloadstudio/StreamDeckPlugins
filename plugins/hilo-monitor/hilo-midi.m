#import <Foundation/Foundation.h>
#import <CoreMIDI/CoreMIDI.h>
#import <dispatch/dispatch.h>
#include <ctype.h>
#include <signal.h>
#include <time.h>
#include <unistd.h>

static const UInt8 manufacturer[] = {0xf0, 0x00, 0x01, 0x54};
typedef struct {
    unsigned gainRegister;
    unsigned muteRegister;
    unsigned muteShift;
} AudioOutput;

static const AudioOutput monitorOut = {0x28, 0x220, 4};
// Lynx maps Phones L/R to output channels 2/3 and Monitor L/R to 4/5.
static const AudioOutput phonesOut = {0x29, 0x220, 2};
static const unsigned monitorDigital[] = {0x204, 0x205};
static const int digitalUnity = 24;
static const int digitalFloor = 216;
static const int unity = 192;
static const int minimumGain = 1; // -95.5 dB; original Hilo does not accept a zero write
static const int minimumAudible = 49; // -71.5 dB
static const int fineRange = 172; // -10 dB
enum { routeGains = 64, routeBytes = 72 };
static volatile sig_atomic_t cancelled;
static BOOL quickStatus;
static BOOL reportProgress;
static double lastProgress;

static void cancelCommand(int signalNumber) {
    cancelled = 1;
}

static double monotonicTime(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return now.tv_sec + now.tv_nsec / 1e9;
}

static void publishGain(int value, BOOL final) {
    if (!reportProgress) return;
    const double now = monotonicTime();
    if (!final && now - lastProgress < 0.08) return;
    lastProgress = now;
    printf("LEVEL %d\n", value);
    fflush(stdout);
}

typedef struct {
    unsigned reg;
    int value;
    int expected;
    BOOL armed;
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
            message[6] != 0) return -1;
        return (message[7] << 1) | (message[8] >> 6);
    }
    if (message[4] != 0x77 || message[5] != reg >> 9 || message[6] != ((reg >> 2) & 0x7f) ||
        message[7] != ((reg & 3) << 5) || message[8] || message[9]) return -1;
    return (message[10] << 1) | (message[11] >> 6);
}

static int receiveValue(MIDIPortRef output, MIDIEndpointRef destination, unsigned reg, int expected,
    dispatch_semaphore_t response, NSLock *lock, RegisterReply *reply) {
    [lock lock];
    dispatch_semaphore_wait(response, DISPATCH_TIME_NOW);
    reply->reg = reg;
    reply->value = -1;
    reply->expected = expected;
    reply->armed = YES;
    [lock unlock];
    // A write is sent at most once. If a stale reply arrives, read the register
    // again and keep the ramp stopped until this exact half-decibel is confirmed.
    if (expected < 0 || sendRegister(output, destination, reg, YES, (UInt8)expected) == noErr) {
        const int waitMs = quickStatus ? 45 : expected < 0 ? 250 : 80;
        for (int attempt = 0; attempt < (quickStatus ? 2 : 3); attempt++) {
            if (quickStatus && cancelled) break;
            if (sendRegister(output, destination, reg, NO, 0) != noErr) break;
            if (dispatch_semaphore_wait(response, dispatch_time(DISPATCH_TIME_NOW, waitMs * NSEC_PER_MSEC)) == 0) break;
        }
    }
    [lock lock];
    int result = reply->value;
    reply->armed = NO;
    [lock unlock];
    return result;
}

static int requestValue(MIDIPortRef output, MIDIEndpointRef destination,
    unsigned reg, dispatch_semaphore_t response, NSLock *lock, RegisterReply *reply) {
    return receiveValue(output, destination, reg, -1, response, lock, reply);
}

static BOOL setValue(MIDIPortRef output, MIDIEndpointRef destination,
    unsigned reg, int current, int target, dispatch_semaphore_t response, NSLock *lock, RegisterReply *reply) {
    return current == target || receiveValue(output, destination, reg, target, response, lock, reply) == target;
}

static double smoothstep(double value) {
    value = MAX(0, MIN(1, value));
    return value * value * (3 - 2 * value);
}

static BOOL rampGain(MIDIPortRef output, MIDIEndpointRef destination,
    unsigned gainRegister, int current, int target, BOOL button,
    dispatch_semaphore_t response, NSLock *lock, RegisterReply *reply) {
    const int direction = target > current ? 1 : -1;
    const double deadline = monotonicTime() + 5;
    while (current != target) {
        if (cancelled || monotonicTime() >= deadline) return NO;
        const int next = current + direction;

        if (!setValue(output, destination, gainRegister, current, next, response, lock, reply)) {
            return NO;
        }
        current = next;
        publishGain(current, NO);
        if (current != target) {
            const double quiet = smoothstep(((unity - current) * 0.5 - 64) / 19.0);
            const double nearTop = 1 - smoothstep((unity - current) * 0.5 / 18.0);
            const double period = button ? 10000 + 12000 * nearTop : 10000;
            usleep((useconds_t)(period * (1 - quiet) + 2500 * quiet));
        }
    }
    return !cancelled;
}

static double baseHoldRate(int gain, BOOL up, double elapsed) {
    const double dbBelowUnity = (unity - gain) * 0.5;
    const double ease = smoothstep(elapsed / (up ? 0.38 : 0.28));
    const double range = smoothstep(dbBelowUnity / 26.0);
    const double rate = up ? (6 + 31 * ease) * (0.28 + 0.72 * range)
        : 9 + (41 - 9 * smoothstep(dbBelowUnity / 60.0)) * ease;
    const double quiet = smoothstep((dbBelowUnity - 64) / 19.0);
    return rate * (1 - quiet) + (0.5 / 0.003) * quiet;
}

static double holdRate(int gain, BOOL up, double elapsed) {
    // Compress both the acceleration envelope and time between confirmed steps.
    return up ? 2 * baseHoldRate(gain, YES, 2 * elapsed) : baseHoldRate(gain, NO, elapsed);
}

static BOOL holdGain(MIDIPortRef output, MIDIEndpointRef destination, unsigned gainRegister, int *current, BOOL up,
    dispatch_semaphore_t response, NSLock *lock, RegisterReply *reply) {
    const int end = up ? unity : MIN(*current, minimumGain);
    const double start = monotonicTime();
    while (*current != end && !cancelled && monotonicTime() - start < 3.45) {
        const double stepStart = monotonicTime();
        const int next = *current + (up ? 1 : -1);
        if (!setValue(output, destination, gainRegister, *current, next, response, lock, reply)) return NO;
        *current = next;
        publishGain(*current, NO);
        if (next == end || cancelled) break;
        const double period = 0.5 / holdRate(next, up, stepStart - start);
        const double remaining = period - (monotonicTime() - stepStart);
        if (remaining > 0) usleep((useconds_t)(remaining * 1e6));
    }
    return !cancelled;
}

static int raisedTarget(int current, int steps) {
    return current >= fineRange ? MIN(unity, current + 1) : MIN(fineRange, current + steps);
}

static int adjacentDetent(int current, BOOL up) {
    // Anchor the same sequence of stops at unity in both directions. This
    // makes an Up followed by a Down reversible across taper transitions.
    int high = unity;
    while (high > minimumAudible) {
        const double attenuation = (unity - high) * 0.5;
        const int spacing = 1 + (int)lround(2 * smoothstep((attenuation - 8) / 30.0) +
            3 * smoothstep((attenuation - 36) / 34.0));
        const int low = MAX(minimumAudible, high - spacing);
        if (up && low <= current && current < high) return high;
        if (!up && low < current && current <= high) return low;
        high = low;
    }
    return current;
}

static int buttonTarget(int current, BOOL up, int tier) {
    if (up && current < minimumAudible) return minimumAudible;
    if (!up && current <= minimumAudible) return MIN(current, minimumGain);
    int target = current;
    for (int i = 0; i < (tier == 3 ? 4 : tier); i++) {
        target = adjacentDetent(target, up);
    }
    if (tier == 1) return target;
    // Rapid taps get at most 5.5 dB each, tapering to 1 dB near unity.
    const double attenuation = (unity - current) * 0.5;
    const int cap = 2 + (int)lround(9 * smoothstep((attenuation - 10) / 26.0));
    return up ? MIN(target, current + cap) : MAX(target, current - cap);
}

static BOOL validDigitalLevel(int level) {
    return level >= digitalUnity && level <= digitalFloor;
}

static unsigned routeRegister(int index) {
    // Mixer rows 4 and 5 are Monitor Out L/R. Four mute bytes per row.
    return index < routeGains ? 0x480 + index : 0x110 + index - routeGains;
}

static BOOL parseRoute(const char *hex, int route[routeBytes]) {
    if (strlen(hex) != routeBytes * 2) return NO;
    for (int i = 0; i < routeBytes; i++) {
        char byte[] = {hex[i * 2], hex[i * 2 + 1], 0};
        char *end;
        long value = strtol(byte, &end, 16);
        if (*end || !isxdigit((unsigned char)byte[0]) || !isxdigit((unsigned char)byte[1]) ||
            (i < routeGains && !validDigitalLevel((int)value))) return NO;
        route[i] = (int)value;
    }
    return YES;
}

static BOOL routeValue(MIDIPortRef output, MIDIEndpointRef destination, int i,
    int current[routeBytes], int target, dispatch_semaphore_t response, NSLock *lock, RegisterReply *reply) {
    if (cancelled || !setValue(output, destination, routeRegister(i), current[i], target, response, lock, reply)) return NO;
    current[i] = target;
    return YES;
}

static BOOL applyRoute(MIDIPortRef output, MIDIEndpointRef destination, int current[routeBytes],
    const int target[routeBytes], dispatch_semaphore_t response, NSLock *lock, RegisterReply *reply) {
    // Silence removed routes before touching any mix gains. Enable new
    // routes only after their gains are verified.
    for (int i = routeGains; i < routeBytes; i++) {
        if (!routeValue(output, destination, i, current, current[i] | target[i], response, lock, reply)) return NO;
    }
    for (int pass = 0; pass < 2; pass++) {
        for (int i = 0; i < routeGains; i++) {
            if ((pass == 0 && target[i] > current[i]) || (pass == 1 && target[i] < current[i])) {
                if (!routeValue(output, destination, i, current, target[i], response, lock, reply)) return NO;
            }
        }
    }
    for (int i = routeGains; i < routeBytes; i++) {
        if (!routeValue(output, destination, i, current, target[i], response, lock, reply)) return NO;
    }
    return YES;
}

static BOOL rampDigital(MIDIPortRef output, MIDIEndpointRef destination, int current[2], const int target[2],
    dispatch_semaphore_t response, NSLock *lock, RegisterReply *reply) {
    const double deadline = monotonicTime() + 5;
    const BOOL dimming = target[0] >= current[0] && target[1] >= current[1];
    const useconds_t stepPause = dimming ? 7000 : 10000;
    const int leftRemaining = target[0] - current[0];
    const int rightRemaining = target[1] - current[1];
    if (leftRemaining != rightRemaining) {
        // Attenuate the less dimmed channel so both channels can ramp together.
        const int channel = leftRemaining > rightRemaining ? 0 : 1;
        const int next = current[channel] + abs(leftRemaining - rightRemaining);
        if (cancelled || !setValue(output, destination, monitorDigital[channel], current[channel], next,
            response, lock, reply)) return NO;
        current[channel] = next;
    }
    while (current[0] != target[0] || current[1] != target[1]) {
        if (cancelled || monotonicTime() >= deadline) return NO;
        for (int channel = 0; channel < 2; channel++) {
            if (current[channel] == target[channel]) continue;
            // Attenuate in 1 dB steps. Return to the listening level in 0.5 dB steps.
            const int next = dimming ? MIN(current[channel] + 2, target[channel]) : current[channel] - 1;
            if (!setValue(output, destination, monitorDigital[channel], current[channel], next, response, lock, reply)) {
                return NO;
            }
            current[channel] = next;
        }
        if (current[0] != target[0] || current[1] != target[1]) usleep(stepPause);
    }
    return YES;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        signal(SIGTERM, cancelCommand);
        const BOOL phones = argc >= 2 && strcmp(argv[1], "phones") == 0;
        if (phones) {
            argv++;
            argc--;
        }
        const AudioOutput audio = phones ? phonesOut : monitorOut;
        const unsigned gainRegister = audio.gainRegister;
        const unsigned muteRegister = audio.muteRegister;
        const int muteMask = 3 << audio.muteShift;
        char *end = NULL;
        NSString *action = argc >= 2 ? @(argv[1]) : @"";
        quickStatus = [action isEqualToString:@"read-status"];
        reportProgress = getenv("HILO_MONITOR_PROGRESS") != NULL;
        lastProgress = 0;
        BOOL mute = [action isEqualToString:@"mute"];
        BOOL forceMute = [action isEqualToString:@"force-mute"];
        BOOL readMute = [action isEqualToString:@"read-mute"];
        BOOL up = [action isEqualToString:@"up"] || [action isEqualToString:@"hold-up"];
        BOOL down = [action isEqualToString:@"down"] || [action isEqualToString:@"hold-down"];
        BOOL repeat = [action hasPrefix:@"hold-"];
        BOOL readDigital = [action isEqualToString:@"read-digital"];
        BOOL setDigital = [action isEqualToString:@"set-digital"];
        BOOL readRoute = [action isEqualToString:@"read-route"];
        BOOL setRoute = [action isEqualToString:@"set-route"];
        if (phones && (readDigital || setDigital || readRoute || setRoute)) return 1;
        BOOL buttonTap = (up || down) && !repeat;
        int tapTiers[2] = {1, 1};
        int tapCount = 1;
        int expectedRoute[routeBytes], targetRoute[routeBytes];
        int expectedDigital[2], targetDigital[2];
        if (setRoute && argc == 4) {
            if (!parseRoute(argv[2], expectedRoute) || !parseRoute(argv[3], targetRoute)) return 1;
        } else if (setDigital && argc == 6) {
            for (int index = 0; index < 4; index++) {
                const char *argument = argv[index + 2];
                long value = strtol(argument, &end, 10);
                if (end == argument || *end || value < digitalUnity || value > digitalFloor) return 1;
                if (index < 2) expectedDigital[index] = (int)value;
                else targetDigital[index - 2] = (int)value;
            }
            const int left = targetDigital[0] - expectedDigital[0];
            const int right = targetDigital[1] - expectedDigital[1];
            // An interrupted pair may be one dB out of sync. The ramp first
            // attenuates the less dimmed channel, even when restoring.
            if (abs(left) > 30 || abs(right) > 30 ||
                (left != right && ((left < 0 && right > 0) || (right < 0 && left > 0) ||
                    abs(left - right) > 2))) return 1;
        } else if (buttonTap && argc >= 2 && argc <= 4) {
            for (int i = 2; i < argc; i++) {
                if (argv[i][0] < '1' || argv[i][0] > '3' || argv[i][1]) return 1;
                tapTiers[i - 2] = argv[i][0] - '0';
            }
            tapCount = MAX(1, argc - 2);
        } else if (argc != 2 || setDigital || setRoute) {
            return 1;
        }
        long steps = action.length ? strtol(argv[1], &end, 10) : 0;
        if (!(quickStatus || mute || forceMute || readMute || up || down || readDigital || setDigital || readRoute || setRoute) &&
            (!end || end == argv[1] || *end || steps < -10 || steps > 10)) {
            fprintf(stderr, "Invalid Hilo output command.\n");
            return 1;
        }
        unsigned reg = mute || forceMute || readMute ? muteRegister : gainRegister;

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
                            if (reply.armed && parsed >= 0 && reply.value < 0 &&
                                (reply.expected < 0 || parsed == reply.expected)) {
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
        if (status != noErr || MIDIPortConnectSource(input, source, NULL) != noErr) {
            fprintf(stderr, "Cannot open the Hilo MIDI input.\n");
            MIDIClientDispose(client);
            return 1;
        }

        if (quickStatus) {
            const int gain = requestValue(output, destination, gainRegister, response, lock, &reply);
            const int muted = gain >= 0 && gain <= unity && !cancelled
                ? requestValue(output, destination, muteRegister, response, lock, &reply) : -1;
            if (muted < 0 || cancelled) {
                fprintf(stderr, "Cannot read the current Hilo output status.\n");
                MIDIClientDispose(client);
                return 1;
            }
            printf("STATUS %d %d\n", gain, (muted & muteMask) >> audio.muteShift);
            fflush(stdout);
            MIDIClientDispose(client);
            return 0;
        }

        if (readRoute || setRoute) {
            int route[routeBytes];
            for (int i = 0; i < routeBytes; i++) {
                if (cancelled) {
                    MIDIClientDispose(client);
                    return 1;
                }
                route[i] = requestValue(output, destination, routeRegister(i), response, lock, &reply);
                if (route[i] < 0 || (i < routeGains && !validDigitalLevel(route[i])) ||
                    (setRoute && route[i] != expectedRoute[i])) {
                    fprintf(stderr, "Cannot verify the expected Monitor Out routing.\n");
                    MIDIClientDispose(client);
                    return 1;
                }
            }
            if (setRoute && !applyRoute(output, destination, route, targetRoute, response, lock, &reply)) {
                fprintf(stderr, "Could not confirm all Monitor Out routing changes.\n");
                MIDIClientDispose(client);
                return 1;
            }
            for (int i = 0; i < routeBytes; i++) printf("%02x", route[i]);
            puts("");
            fflush(stdout);
            MIDIClientDispose(client);
            return 0;
        }

        if (readDigital || setDigital) {
            int digital[2];
            for (int channel = 0; channel < 2; channel++) {
                digital[channel] = requestValue(output, destination, monitorDigital[channel], response, lock, &reply);
                if (!validDigitalLevel(digital[channel]) || (setDigital && digital[channel] != expectedDigital[channel])) {
                    fprintf(stderr, "Cannot verify the expected Hilo Monitor Out digital levels.\n");
                    MIDIClientDispose(client);
                    return 1;
                }
            }
            if (setDigital && !rampDigital(output, destination, digital, targetDigital, response, lock, &reply)) {
                fprintf(stderr, "Cannot confirm the Hilo Dim ramp.\n");
                MIDIClientDispose(client);
                return 1;
            }
            printf("%d %d\n", digital[0], digital[1]);
            MIDIClientDispose(client);
            return 0;
        }

        int current = requestValue(output, destination, reg, response, lock, &reply);
        if (current < 0 || (reg == gainRegister && current > unity)) {
            fprintf(stderr, "Cannot verify the Hilo output state.\n");
            MIDIClientDispose(client);
            return 1;
        }
        int target = current;
        BOOL verified;
        if (mute || forceMute) {
            target = !forceMute && (current & muteMask) == muteMask
                ? current & ~muteMask : current | muteMask;
            verified = !cancelled && setValue(output, destination, reg, current, target, response, lock, &reply);
        } else if (readMute) {
            verified = YES;
        } else {
            if (buttonTap) {
                for (int i = 0; i < tapCount; i++) target = buttonTarget(target, up, tapTiers[i]);
            }
            else if (steps > 0) target = raisedTarget(current, (int)steps);
            else if (steps < 0) target = (int)MAX(MIN(current, minimumGain), current + steps);

            int muteState = up
                ? requestValue(output, destination, muteRegister, response, lock, &reply) : 0;
            if (muteState < 0) {
                fprintf(stderr, "Cannot read the Hilo output mute state.\n");
                MIDIClientDispose(client);
                return 1;
            }
            if (muteState & muteMask) {
                if (repeat) {
                    puts("Limit");
                    MIDIClientDispose(client);
                    return 0;
                }
                // A fresh Up tap unmutes without rewriting the listening level.
                target = current;
                verified = !cancelled && setValue(output, destination, muteRegister, muteState,
                    muteState & ~muteMask, response, lock, &reply);
            } else {
                if (repeat) {
                    verified = holdGain(output, destination, gainRegister, &target, up, response, lock, &reply);
                } else {
                    verified = rampGain(output, destination, gainRegister, current, target, buttonTap, response, lock, &reply);
                }
                if (verified && down && target <= minimumGain) {
                    int muted = requestValue(output, destination, muteRegister, response, lock, &reply);
                    verified = !cancelled && muted >= 0 && setValue(output, destination, muteRegister, muted,
                        muted | muteMask, response, lock, &reply);
                }
            }
        }

        if (!verified) {
            fprintf(stderr, "Cannot confirm the new Hilo output state.\n");
            MIDIClientDispose(client);
            return 1;
        }
        if (reg == gainRegister) publishGain(target, YES);
        if (reg == muteRegister) puts((target & muteMask) == muteMask ? "Muted" : "Unmuted");
        else if (repeat) puts("Limit");
        else if ((down && target <= minimumGain) || target == 0) puts("Off");
        else printf("%.1f\n", (target - unity) * 0.5);
        fflush(stdout);
        MIDIClientDispose(client);
        return 0;
    }
}
