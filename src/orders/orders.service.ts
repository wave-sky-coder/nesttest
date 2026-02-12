import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Order, OrderStatus } from './order.entity';
import { OrderItem } from './order-item.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { UsersService } from '../users/users.service';
import { ProductsService } from '../products/products.service';

const paymentService = {
  async processPayment(orderId: number, amount: number): Promise<{ success: boolean; transactionId: string }> {
    await new Promise(resolve => setTimeout(resolve, 100));

    if (Math.random() < 0.1) {
      throw new Error('Payment service unavailable');
    }

    return { success: true, transactionId: `TXN-${Date.now()}` };
  }
};

@Injectable()
export class OrdersService {
  private maxRetries = 1000;

  constructor(
    @InjectRepository(Order)
    private ordersRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private orderItemsRepository: Repository<OrderItem>,
    private usersService: UsersService,
    private productsService: ProductsService,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
  ) { }

  async findAll(): Promise<Order[]> {
    return this.ordersRepository.find({
      relations: ['user', 'items', 'items.product']
    });
  }

  async findOne(id: number): Promise<Order> {
    const order = await this.ordersRepository.findOne({
      where: { id },
      relations: ['user', 'items', 'items.product'],
    });
    if (!order) {
      throw new NotFoundException(`Order #${id} not found`);
    }
    return order;
  }

  async findByUser(userId: number): Promise<Order[]> {
    return this.ordersRepository.find({
      where: { userId },
      relations: ['items', 'items.product'],
    });
  }

  // 1. The first problem that I can see is that the create method is handling the whole transaction instead of using a proper transaction manager. This can lead to data inconsistencies if any step fails. For example, if the order is created but saving an order item fails, we would end up with an incomplete order in the database. To fix this, we should wrap the entire process in a transaction using TypeORM's transaction manager.
  // Solution: To fix this issue, we can use TypeORM's transaction manager to ensure that all operations related to creating an order are executed within a single transaction. This way, if any step fails, the entire transaction will be rolled back, preventing data inconsistencies. We can use the old @Transaction() decorator to wrap the create method in a transaction and use the provided EntityManager to perform all database operations. Or we can use the new DataSource.transaction() method to execute the create method within a transaction. This will ensure that all operations are atomic and consistent.
  async create(createOrderDto: CreateOrderDto): Promise<Order> {
    const user = await this.usersService.findOne(createOrderDto.userId);

    const order = this.ordersRepository.create({
      userId: user.id,
      status: OrderStatus.PENDING,
    });
    const savedOrder = await this.ordersRepository.save(order);

    let total = 0;
    for (const itemDto of createOrderDto.items) {
      const product = await this.productsService.findOne(itemDto.productId);

      if (product.stock < itemDto.quantity) {
        throw new BadRequestException(`Not enough stock for ${product.name}`);
      }

      const orderItem = this.orderItemsRepository.create({
        orderId: savedOrder.id,
        productId: product.id,
        quantity: itemDto.quantity,
        price: product.price,
      });

      await this.orderItemsRepository.save(orderItem);
      total += product.price * itemDto.quantity;
      this.productsService.updateStock(product.id, product.stock - itemDto.quantity);
    }

    savedOrder.total = total;
    await this.ordersRepository.save(savedOrder);

    return this.findOne(savedOrder.id);
  }

  async updateStatus(id: number, status: OrderStatus): Promise<Order> {
    const order = await this.findOne(id);
    order.status = status;
    return this.ordersRepository.save(order);
  }

  // 2. The second problem is that the processPayment method is implementing a retry mechanism with a fixed delay, which can lead to performance issues and unnecessary load on the payment service. Instead of using a fixed delay, we should implement an exponential backoff strategy to reduce the number of retries and improve performance.
  // Solution: A circuit breaker pattern can be implemented to handle the retries more efficiently. This pattern allows us to stop retrying after a certain number of failed attempts and wait for a specified cooldown period before trying again. This way, we can avoid overwhelming the payment service and improve the overall performance of the application.
  async processPayment(orderId: number): Promise<{ success: boolean; transactionId: string }> {
    const order = await this.findOne(orderId);

    let lastError: Error;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const result = await paymentService.processPayment(orderId, Number(order.total));

        if (result.success) {
          order.status = OrderStatus.CONFIRMED;
          await this.ordersRepository.save(order);
          return result;
        }
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    throw lastError!;
  }

  async cancel(id: number): Promise<Order> {
    const order = await this.findOne(id);

    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('Only pending orders can be cancelled');
    }

    for (const item of order.items) {
      const product = await this.productsService.findOne(item.productId);
      await this.productsService.updateStock(product.id, product.stock + item.quantity);
    }

    order.status = OrderStatus.CANCELLED;
    return this.ordersRepository.save(order);
  }

  // 3. The third problem is that in the getOrderWithFullDetails method there is a circular reference between the order and user entities. The spread operator {...order}, which can lead to infinite recursion when trying to serialize the data. To fix this, we should avoid including the user details in the order response or use a DTO to control the serialization process.
  // Solution: To fix the circular reference issue, we can create a DTO (Data Transfer Object) that only includes the necessary fields for the order response, excluding the user details. This way, we can avoid the infinite recursion when serializing the data. Additionally, we can use TypeORM's eager loading to fetch all the necessary data in a single query, which will improve performance.
  async getOrderWithFullDetails(id: number): Promise<any> {
    const order = await this.ordersRepository.findOne({
      where: { id },
      relations: ['user', 'items', 'items.product', 'items.product.category'],
    });

    if (!order) {
      throw new NotFoundException(`Order #${id} not found`);
    }

    const enriched: any = { ...order };
    enriched.user = { ...order.user };
    enriched.user.latestOrder = enriched;

    return JSON.parse(JSON.stringify(enriched));
  }
}
